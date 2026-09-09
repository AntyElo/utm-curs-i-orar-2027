# Gate E: GE-N01 / GE-N02 / GE-N03 implementation notes

Scope: filename consistency, persistent-storage retention, and reconciliation pagination.
No changes to Render selection, accepted state, bootstrap, transport, Queue topology, or WAF handling.

## Filename invariant (GE-N01)

`worker-shared/fcim-policy.ts` owns the single filename validator: 1–191 stem characters,
an ASCII alphanumeric first character, remaining ASCII alphanumeric/underscore/dot/hyphen,
and a case-insensitive `.pdf` extension. Total length is 5–195 characters. Traversal (`..`)
and trailing line breaks are rejected. Official URL checks still reject query and fragment syntax.

URL validation, ingest validation, planned descriptor entries, and PDF serving use this policy.
Upload-month qualification truncates the stem if necessary, preserving the extension and limit;
file-ID qualification handles a secondary collision. Planning validates generated jobs before
writing even the Page API object. An unresolvable naming collision fails discovery before storage.
Finalization and reconciliation validate the descriptor's jobs as a set (including duplicate IDs/keys).
A corrupt descriptor produces a deterministic snapshot diagnostic, no poison requeue, and no CAS.
Ingest also rejects such a descriptor. These failures age out under the same retention policy.

## Retention and publication deadline (GE-N02)

| Constant | Value |
| --- | --- |
| Publication/repair maximum age | 6 hours |
| Minimum reconciliation age | 5 minutes |
| Retention eligibility age | Strictly older than 24 hours |
| Protected snapshot history | Current plus two predecessors from immutable manifests |
| GC prefix scan | 8 prefixes per namespace (`pending/`, `snapshots/`) per invocation |
| GC delete budget | At most 4 prefixes, at most 64 objects each (256 objects total) |

All snapshots within 24 hours are retained. Older snapshots are deleted unless protected by the
current/history set. Older pending metadata is deleted except for current's own pending prefix.
Thus old finalized, abandoned, failed, and orphaned prefixes converge to the retained set; current
may keep one pending prefix indefinitely. A snapshot with no useful HTTP validators still gets
conservative freshness checks: HTTP 200 can create a new snapshot even with equal Content-Length.

The existing six-hour reconciliation deadline now also gates ingest and finalize. Finalize checks
it again immediately before CAS. Expired same-predecessor work therefore cannot win publication.
The 18-hour gap between the work deadline and GC eligibility drains invocations that passed an
earlier deadline check. Publication is Queue-only; Cloudflare documents a maximum 15-minute Queue
invocation wall time. This gap is a safety requirement, not just a storage tuning parameter.
[Cloudflare Queue limits](https://developers.cloudflare.com/queues/platform/limits/).

GC derives age from calendar-validated structured IDs, not stored `created_at` or string ordering.
It fails closed if current or the required retained-manifest chain cannot be read safely. It checks
current's ETag before each prefix deletion and stops if publication changed the retained set.
A new publication can only reference its observed current predecessor, which the sweep protects;
an expired deletion candidate cannot publish itself. Accepted payloads/pointers are outside GC.

Deletion uses the existing R2 `delete(string[])` API. Cloudflare documents strongly consistent
deletes and a maximum of 1,000 keys per call; this implementation uses at most 64. Prefix deletion
can be partial, and subsequent cursor sweeps finish it. A crash before cursor persistence repeats
safe cleanup. No bucket lifecycle rule or live infrastructure change is required.
[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

## Pagination and budgets (GE-N03)

Reconciliation scans at most three pages of up to 100 prefixes. It follows `truncated` and opaque
`cursor` even when R2 returns fewer than the requested limit. It saves continuation for the next
scheduled invocation under `maintenance/reconcile.json`; exhausted scans reset to the start.
More than 300 old prefixes therefore cannot permanently hide later work. GC independently saves
its two cursors under `maintenance/gc-pending.json` and `maintenance/gc-snapshots.json`.

Within the bounded scan set, candidates are ordered newest first, filtered for age, absent manifest,
descriptor validity and observed current ETag, and at most three eligible snapshots are repaired.
Only missing completion markers cause ingest requeue. Cursors advance after successful dispatch;
a dispatch failure repeats idempotent repair. Pagination is correct even while GC is behind.

Maintenance performs no upstream requests or PDF body reads. GC normally needs at most 21 R2
operations for four deletions. The conservative bound is 45 if concurrent cleanup makes listed
prefixes empty (3 current/history reads, 6 listing/cursor operations, up to 32 prefix checks/lists,
and 4 deletes).
Reconciliation scans at most 300 prefixes and reads metadata for eligible-age candidates; actual
repair remains capped at three snapshots. Stored bytes remain dependent on catalogue sizes and
publication rate during the 24-hour window. This bounds historical growth under the scheduled
workload; it is not an exact byte quota or a measured production CPU guarantee. Cleanup must keep
running, and sustained creation beyond cleanup throughput can still build a backlog.

## Regression evidence and safety

`tests/broker-gate-e-fixup.test.ts` covers filename boundaries/case, qualification, real Queue
publication, deterministic descriptor failure, protected current/history, active and expired
same-CAS work, interrupted cleanup, expiry before CAS, bounded deletion, publication churn,
permanent upstream failures, and later-page work behind 170 and 850 old prefixes.
The R2 double sorts objects and prefixes together and models truncated, opaque-cursor pages,
short pages, deletion, and continuation after preceding keys disappear.

Cases A–D: uppercase publication completes; old superseded data is removed while current survives;
150+ old prefixes cannot starve recent repair; permanent upstream failure retains last-known-good,
with Queue retries bounded to the existing configuration, repair limited to six hours, and expired
storage eventually removed. Create-only children and manifest-before-current-CAS ordering remain.

Historical regression scope: E-01 authoritative Render selection (`broker-contract`), E-04 resync
hard gate (`accepted-state-sync`), E-07 concurrent bootstrap/deadline (`bootstrap-deadline`), NR-A
complete transport inventory (`broker-split-publication`), NR-D strict pointer parsing
(`broker-security`). No LOW backlog sweep or independent audit is included in this implementation.
