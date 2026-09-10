# Gate F: MD Publisher

Scope: authenticated broker-authored candidate ingestion, the transport-only client that feeds it,
and the operational envelope around both. No change to Render's parser, validator, selection or
accepted-state semantics.

## Trust model

The Moldova laptop is transport-only.

| It may | It must not |
| --- | --- |
| Fetch the canonical FCIM Page API | Parse timetable semantics |
| Discover official PDF URLs | Make acceptance decisions |
| Download and hash raw PDF bytes | Construct accepted schedules |
| Upload candidate bytes | Write `accepted/course-*` or `accepted-payloads/*` |
| Request candidate completion | Choose an `accepted_id`, snapshot id, R2 key or filename |
| Write a publisher heartbeat | Mutate arbitrary R2 keys, write `current.json`, bypass Render |

Render remains the sole semantic authority. The broker remains a transport that mirrors every
strictly-valid official timetable PDF the authoritative page references.

## Credentials

| Credential | Holder | Grants |
| --- | --- | --- |
| `MD_PUBLISHER_TOKEN` | the laptop | the six publisher routes below, nothing else |
| `MD_PUBLISHER_TOKEN_PREVIOUS` | the laptop, during rotation | the same, until it is removed |
| `SCHEDULE_BROKER_SECRET` | Render | `PUT /accepted/*` and `PUT /accepted-payloads/*`, nothing else |

The separation is enforced, not assumed:

- publisher routes compare only against the two publisher tokens; accepted-state routes compare
  only against `SCHEDULE_BROKER_SECRET`, so neither credential works on the other's routes;
- if `MD_PUBLISHER_TOKEN` (or its rotation predecessor) is ever configured to the value of
  `SCHEDULE_BROKER_SECRET`, **publisher routes fail closed** with
  `503 publisher_credentials_misconfigured`;
- a publisher token shorter than 32 characters fails closed the same way;
- comparison is over SHA-256 digests, so it is constant-time and leaks neither contents nor length;
- the broker never logs a token value, never echoes one in a response, and never stores one in R2,
  the manifest or the heartbeat.

### Where the publisher token actually lives

The broker never persists it. **The laptop does**, and the documented setup is what persists it:

- the publisher reads `MD_PUBLISHER_TOKEN` from its process environment and holds it in memory for
  the length of a run; it writes no token into the state directory, `last-run.json`, `run/`, the
  heartbeat, or any log line it emits;
- the documented Windows install uses `setx MD_PUBLISHER_TOKEN`, which writes the value into the
  current user's persistent environment — that is, into that user's registry hive
  (`HKCU\Environment`). Anything running as that user can read it back, and it survives reboots.
  That is what makes an unattended scheduled task possible at all;
- so the credential must be treated as a user secret on that machine: the account is the security
  boundary. Do not install the token under an account other people log into, and rotate it if that
  account is ever shared, imaged or compromised.

The token is deliberately low-privilege, which is what keeps that residual exposure acceptable: it
grants the six publisher routes and nothing else. It cannot write accepted state, cannot make
Render believe anything, and cannot choose a snapshot id, filename, R2 key or source URL. The worst
a stolen publisher token buys is publications of strictly-valid official PDFs — see the compromise
envelope below.

Rotation: set `MD_PUBLISHER_TOKEN_PREVIOUS` to the old value, set `MD_PUBLISHER_TOKEN` to the new
one, update the laptop, then delete `MD_PUBLISHER_TOKEN_PREVIOUS`.

## Broker API

| Route | Credential | Purpose |
| --- | --- | --- |
| `POST /publications` | publisher | open or resume one publication |
| `GET /publications/:snapshot_id` | publisher | the broker's plan and per-file upload state |
| `PUT /publications/:snapshot_id/files/:file_id` | publisher | one checksum-validated PDF body |
| `POST /publications/:snapshot_id/complete` | publisher | close the snapshot; may advance `current.json` |
| `PUT /publisher/heartbeat` | publisher | bounded liveness, broker-stamped |
| `GET /publication-status` | publisher | bounded operational state |

`POST /publish` no longer exists, at any spelling, with any credential.

### The broker derives all candidate structure

The publisher supplies raw Page API bytes and an attempt id. The broker independently runs
`readPageApiDocument()`, `extractOfficialPdfUrls()` and `planSnapshotFiles()` and returns a plan:
`snapshot_id`, and per file a `file_id`, `filename`, `source_url`, `upload_path` and `status`.
An upload names a `file_id` and nothing else; the key, filename and source URL are looked up from
the broker's own descriptor, so **no client-provided path component ever reaches an R2 key**.

### Validation performed server-side

Publisher auth · operation UUIDv4 · Page API ≤ 1 MiB · declared page SHA-256 matched against the
actual bytes · valid Page API object · official FCIM URL extraction · safe FCIM filename policy
(GE-N01) · duplicate-basename qualification · open-publication cap (8) · six-hour snapshot expiry ·
`file_id` syntax and descriptor membership · `Content-Type: application/pdf` · `%PDF-` magic ·
PDF body ≤ 25 MiB · exact byte count against `Content-Length` · declared SHA-256 validated by R2 ·
immutable overwrite protection · descriptor consistency · operation/descriptor/page consistency.

### Operation identity (DF-01 / DF-06)

```
publisher_operation_id = client-generated UUIDv4      ← identity
snapshot_id            = broker-generated             ← storage
page_api_sha256        = integrity/provenance only    ← never identity
```

`operations/<operation_id>.json` is create-only and is written **before** any snapshot state, so
the attempt→snapshot mapping is durable first. On a record hit:

| Condition | Response |
| --- | --- |
| Request hash ≠ `operation.page_api_sha256` | `409 operation_payload_mismatch`, zero mutation, snapshot id withheld |
| Descriptor missing | `410 operation_expired` |
| Descriptor `page_api_sha256`/`operation_id` disagrees | `409 operation_state_corrupt` (fail closed) |
| All agree | resume the same publication |

`complete` re-checks the immutable page object's `page_api_sha256` and `operation_id` custom
metadata against the descriptor. On disagreement it returns `409 operation_state_corrupt` and
`runFinalize()` does not execute.

### Same page, changed PDF

This scenario works with no operator action and no force affordance:

```
current: page bytes P, PDF URL U, PDF bytes X
later:   page bytes P, PDF URL U, PDF bytes Y
```

The publisher's conditional revalidation of U answers 200, so it opens a new operation; the broker
generates a new snapshot id, stores identical Page API bytes under it, stores Y, completes, and
`current.json` may advance. Render downloads, sees hash Y ≠ X, and parses, validates and accepts.

### Temporal guards (DF-03)

| Incoming vs current `page_modified_gmt` | Result |
| --- | --- |
| current is `null` | allow |
| incoming `null`, current non-null | `409 stale_page` |
| incoming < current | `409 stale_page` |
| incoming == current | **allow** (in-place PDF replacement) |
| incoming > current | allow |
| incoming > broker now + `MAX_PAGE_FUTURE_SKEW_HOURS` | `400 future_page` |

Default `MAX_PAGE_FUTURE_SKEW_HOURS=26`. A `current.json` that exists but cannot be parsed fails
closed with `503 broker_state_unreadable` — retention and reconciliation are already stalled in
that state, and publishing over an unreadable pointer would be worse than refusing. There is no
publisher-level bypass and no operator override; the deferred override is out of this Gate.

### Upload integrity (DF-05)

The upload streams through a `%PDF-` prefix guard and a byte-counting/fixed-length guard into
`R2.put(key, body, { onlyIf: If-None-Match: *, sha256: <declared> })`. R2 validates the digest
server-side and rejects the write on mismatch, so **unverified bytes never become a final
`snapshots/<id>/pdfs/*` object**. There is no write-then-verify-then-delete path anywhere.

`P0-CHK` — the runtime proof that a wrong declared checksum leaves `head(finalKey) == null`
against a real (disposable, non-production) R2 bucket — has **not** been executed; see below.

## Retention

Unchanged from Gate E for `pending/` and `snapshots/`: the >24 h eligibility, the
current-plus-two-predecessors protection, the per-sweep budgets and the fail-closed behaviour on an
unreadable pointer are all exactly as they were.

`operations/` is the namespace Gate F added, and it is now swept too. Records are flat objects with
no timestamp in the key, so they are aged by the object's own upload time, with a cursor of their
own (`maintenance/gc-operations.json`) and a bound of `GC_MAX_OPERATION_DELETIONS` (64) per sweep,
issued as a single bulk delete. Expiring one is safe well past the threshold: a publication may
only live for six hours, so a record older than 24 h can no longer be resumed, and its id — a
random UUIDv4 generated once by the client — will never be presented again.

## Partial publication semantics

Unchanged from Gate E. `page-api.json`, the descriptor, every PDF object, every completion marker
and the manifest are create-only; `current.json` is conditional-CAS only, and only after a snapshot
is proven complete. An incomplete publication can never become current. The 6 h publication/repair
deadline, the >24 h retention eligibility, the current-plus-two-predecessors protection and the
bounded maintenance budgets are the Gate E guarantees and remain authoritative.

## Queue and cron

```
scheduled() ──▶ enqueue reconcile only
queue()     ──▶ finalize | reconcile
```

The `discover` and `ingest_pdf` job kinds are removed. A surviving message of either kind fails
job validation, is logged and acknowledged, and never executes. `runReconcile()` may re-drive
finalize and run retention; it never re-enqueues an upload and never fetches FCIM. After this
change there is no reachable `queue()`/`scheduled()` path that performs an FCIM GET. The
dead-letter queue is not purged.

## MD Publisher client

`tools/md-publisher/` — Windows-first, Node ≥ 20, no runtime dependencies beyond Node built-ins.

```
md-publisher publish [--dry-run]   the normal scheduled command
md-publisher check                 report upstream drift; read-only at the broker
md-publisher status                print GET /publication-status
md-publisher doctor                configuration, state directory, scheduled-task logon model
```

There is no `--force`, and the usage text does not advertise one.

`check` and `publish --dry-run` are read-only, not broker-free. Both issue broker `GET`s —
`current.json`, and the current snapshot's `manifest.json` and `page-api.json` — because that
snapshot is the only thing "unchanged" can honestly be measured against, and both then perform the
FCIM checks that comparison requires. Neither opens a publication, uploads a file, completes one,
writes accepted state or sends a heartbeat: no broker mutation of any kind.

`publish --dry-run` additionally leaves a resumable attempt alone. If `run/operation.json` and
`run/page.json` still agree, the dry run reports the operation id it *would* resume and returns
without touching them; an observation-only invocation never consumes pending work. Local state
that fails the resume test is still discarded, under the same rule a real run applies (GF-N01).

### Freshness authority

> **The only authoritative freshness baseline is the snapshot `current.json` names.**
> `state/last-run.json` is a cache. It is never correctness-authoritative, and it may be consulted
> only while it is anchored — that is, while it records the id of the snapshot the broker is
> serving *right now*.

Every normal `publish` run therefore begins at the broker, before FCIM is touched at all:

```
GET /current.json                       -> the authoritative snapshot id
  last-run.broker_snapshot_id == it ?   -> use the cache (one small read, nothing more)
  otherwise                             -> GET /snapshots/<id>/manifest.json
                                           GET /snapshots/<id>/page-api.json
                                           and build the baseline from those
```

The manifest supplies the SHA-256 of every mirrored PDF and the validators the broker recorded
next to those exact bytes; `page-api.json` supplies the exact page payload the snapshot was opened
with. Comparing FCIM against those is comparing it against what the broker is really serving.

Consequences, all of them deliberate:

- **A superseded publication advances nothing.** An attempt that loses the `current.json` CAS has
  no claim on the baseline. The cache is re-derived from whatever snapshot *did* win, so the next
  run sees the drift it still has to publish and converges instead of wedging on "unchanged".
- **A resumed publication records the broker's bytes, not the laptop's.** After any completed
  attempt the baseline is re-read from `current.json` and that snapshot's immutable manifest —
  never from the observations the run accumulated while uploading.
- **A failed run never advances the baseline**, and an unreadable or unanchored cache is ignored
  rather than trusted.
- **Deleting the state directory cannot lose freshness.** A fresh clone on another laptop
  converges from broker state alone; the only cost is one extra publication, or one extra pair of
  reads.
- **No baseline ⇒ publish.** No current snapshot, no readable manifest, or a manifest file with no
  recorded digest all mean nothing can be proven unchanged.

### Change detection

Gate E's conservative freshness semantics are preserved: a no-op is reported only when the upstream
can genuinely be treated as unchanged — and now, only when the broker agrees.

1. Conditional GET of the canonical Page API, using the validators of the baseline above. A
   baseline built from a broker snapshot carries no page validator (DF-02), so that request is
   unconditional and the answer is decided by hash — strictly stronger evidence.
2. Conditional revalidation of every PDF the baseline names. **A PDF answering 200 triggers
   publication even when the Page API bytes and URL set did not change.** Any other status is an
   error, never "unchanged".
3. Where no usable validator exists, the body is downloaded and compared by hash — strictly
   stronger evidence than a validator, and it keeps a validator-less upstream from republishing on
   every tick. The downloaded body is reused by the upload phase.
4. `unchanged` re-caches the baseline against the same broker snapshot with refreshed validators
   only; the digests stay the broker's, because the bytes were just proven equal to its own.

### Upstream policy

The Page API endpoint is **not configurable**; it comes from `worker-shared/fcim-policy.ts`. PDF
URLs come only from the broker's returned plan and are revalidated locally against
`isOfficialTimetablePdfUrl()` before every request. Redirects are resolved manually and each hop is
re-checked with `resolveOfficialTimetablePdfRedirect()`; a Page API redirect is refused outright.
This is what stops the laptop from being usable as an SSRF helper by anything that can influence a
URL — including the broker's own plan.

### Upload behaviour and local state

One PDF at a time: download to a temporary file, count bytes, hash SHA-256, verify `%PDF-`, stream
the file to the broker with an exact `Content-Length`, delete the temporary file. No PDF is ever
held in memory.

**A file the plan reports as `stored` is not downloaded at all.** The broker already holds its
immutable bytes and will not accept different ones, so re-fetching it could only produce an
observation about some *other* revision — one that belongs to a future publication, never to the
snapshot being resumed. That revision is still detected: the next run compares live FCIM against
the finished snapshot's manifest and publishes it as a new candidate.

Local state is a cache and a resume aid. Nothing in it is required for correctness, and deleting
the whole directory is safe. `MD_PUBLISHER_STATE_DIR`
(default `%LOCALAPPDATA%\fcim-md-publisher`) holds:

```
state/last-run.json   cached baseline; usable only while broker_snapshot_id == current.json's
run/operation.json    the attempt in flight
run/page.json         the exact bytes that attempt was opened with
run/tmp/, cache/      transient bodies
```

`last-run.json` is schema 2 and always carries `broker_snapshot_id`. A record without one — any
schema-1 file, a hand-edited one, a copy from another machine — is unreadable by construction,
because an unanchored baseline that looks authoritative is exactly the failure this shape exists
to prevent.

An attempt resumes only when `operation.json` exists, `page.json` exists, and
`sha256(page.json) == operation.page_api_sha256`. Anything less is discarded and a new operation id
is minted.

### Error handling

| Broker answer | Publisher |
| --- | --- |
| `409 operation_payload_mismatch` | discard the attempt, mint a new id, retry once |
| `410 operation_expired` | discard the attempt, mint a new id, retry once |
| `409 operation_state_corrupt` | **do not retry**; heartbeat the error; exit non-zero |
| network timeout after a successful upload | recoverable: the next run resumes the same operation and the already-stored file is reported `already_stored` |

Terminal normal outcomes exit `0`: `unchanged`, `published`, `superseded` (and `dry_run`).

**Every completed run reports itself.** `publish` attempts a bounded heartbeat on every terminal
outcome — `unchanged`, `published`, `superseded` and `error` alike — so an FCIM 403, timeout,
refused redirect or network failure becomes a broker-visible *failed publisher run* whenever the
broker itself is reachable, and an `unchanged` run refreshes `received_at` rather than looking
like a laptop that has stopped. A laptop that silently cannot reach FCIM is otherwise
indistinguishable from a calm upstream.

A heartbeat that cannot be delivered is logged (`heartbeat not delivered; the run stands as
<outcome>`), reported as `heartbeat: "failed"` in the JSON result, and changes nothing else: not
the outcome, not the exit code, not the published snapshot. Losing an observation about a
transaction must never corrupt the transaction. `publish --dry-run` and `check` write no heartbeat
at all (`heartbeat: "skipped"`); they mutate nothing anywhere, though both do read the broker's
public pointer and manifest, because a dry run that guessed its baseline would be answering a
different question than `publish` does.

### Observability

`PUT /publisher/heartbeat` stores `publisher/heartbeat.json`. The broker stamps its own
`received_at`; the client timestamp is informational. The record is bounded and validated: an
unrecognised status reads as `error`, a bad snapshot or operation id becomes `null`, strings are
length-clamped and stripped of control characters, and the whole body is capped at 8 KiB. It
carries outcome, upstream page timestamp, PDF count, drift, duration, a bounded error summary and
the logon model — and never a secret.

`GET /publication-status` returns the current snapshot and its age, the number of open
publications, the heartbeat and its age, the accepted pointers, and a `warnings` list
(`current_pointer_unreadable`, `no_publisher_heartbeat`, `publisher_heartbeat_stale`,
`last_publisher_run_failed`, …). This is bounded operational state, not a monitoring platform.

## Windows Task Scheduler

S4U is not used. `install-task.ps1` requires an explicit logon model with no implicit fallback:

```powershell
.\install-task.ps1 -LogonMode Interactive
.\install-task.ps1 -LogonMode Password -User "MACHINE\account"
```

Cadence: **every 20 minutes**, with an **execution time limit of 10 minutes** — materially below
the cadence, so a hung run is reclaimed before the next repetition rather than being skipped by
`MultipleInstances IgnoreNew`. Neither number is a correctness mechanism: a killed run leaves the
broker untouched, and the next run resumes its operation or re-derives its baseline from the
broker. Both are `-IntervalMinutes` / `-ExecutionTimeLimitMinutes` parameters.

- Current laptop recommendation: **Interactive** (it stays logged in).
- Future dedicated laptop: Interactive with a persistent logged-in session, or Password if
  pre-logon/background execution is genuinely required.
- The task runs with `-RunLevel Limited`. The publisher never needs elevation.
- The installer writes the chosen model into `<state dir>\config.json`, so `doctor` and every
  heartbeat report how the machine is actually registered.
- An existing task registered with S4U is **never silently overwritten**: the installer refuses and
  explains, and `doctor` fails with the corrective command.

## Compromise recovery guarantee

> Automatic recovery after `MD_PUBLISHER_TOKEN` compromise is guaranteed **only while poisoned
> candidate material has NOT become durable accepted state.**

While the poisoned candidate is only a candidate: rotate the token and let the genuine publisher
run. It opens a new publication, `current.json` advances, and Render validates and accepts the
genuine timetable. No operator surgery is required.

Once poisoned material has become `accepted/course-N`, automatic recovery is **not** guaranteed:
the durable accepted state is authoritative, and the previous accepted schedule participates in the
validation of its genuine successor. Clearing Render's local state is **not** sufficient — the next
run re-synchronises the poisoned durable state back into local state, which is exactly the failure
mode to expect. Direct Render→FCIM admin refresh is **not** the recovery mechanism either; Render
does not fetch FCIM in this architecture.

The missing capability is tracked as:

```
GF-H01 — operator durable accepted-state recovery / rollback   (HIGH, deferred, out of this Gate)
```

`tests/gate-f-render-trust-boundary.test.ts` locks both halves of this in.

## Configuration

Broker (`wrangler.toml` vars and secrets):

| Name | Kind | Notes |
| --- | --- | --- |
| `MD_PUBLISHER_TOKEN` | secret | ≥ 32 characters; must differ from `SCHEDULE_BROKER_SECRET` |
| `MD_PUBLISHER_TOKEN_PREVIOUS` | secret | rotation only; delete when rotation completes |
| `MAX_PAGE_FUTURE_SKEW_HOURS` | var | default `26` |

Publisher (laptop environment):

| Name | Required | Notes |
| --- | --- | --- |
| `MD_PUBLISHER_BROKER_URL` | yes | bare https origin |
| `MD_PUBLISHER_TOKEN` | yes | ≥ 32 characters |
| `MD_PUBLISHER_STATE_DIR` | no | default `%LOCALAPPDATA%\fcim-md-publisher` |
| `MD_PUBLISHER_TIMEOUT_MS` | no | default `30000` |
| `MD_PUBLISHER_LOGON_MODEL` | no | normally written by the installer |

## Deferred / not done in this pass

- **P0-CHK not executed.** Proving R2's server-side checksum rejection requires a disposable,
  non-production R2 bucket and Cloudflare credentials; creating one was not authorized here and
  production R2 must not be touched. The unit path is proven against an R2 double that models the
  documented behaviour (a mismatched declared digest throws and stores nothing), which is not the
  same as proving it against the real service. **Production rollout stays blocked on P0-CHK.**
- **GF-H01** — operator durable accepted-state recovery / rollback (HIGH).
- **GF-H03** — local cross-process publisher locking (LOW). Two publisher processes on one laptop
  are still only prevented by `MultipleInstances IgnoreNew`; there is no local lock file. Broker-side
  concurrency correctness does not depend on it: immutable objects plus CAS make a second process
  harmless, at worst wasteful. Tracked separately from GF-H01, which it is unrelated to.
- **Stage-2 cleanup** — `worker/src/pdf-fetch.ts`, `fetchPageApi()` in `worker/src/page-api.ts`,
  `worker/src/fcim-egress-client.ts`, `worker-egress/`, the `FCIM_EGRESS` service binding and the
  `FCIM_PAGE_API_URL`/`SCHEDULE_PAGE_URL` vars are unreachable from any deployed route but are
  retained, tested and deliberately not removed alongside the functional cutover.
