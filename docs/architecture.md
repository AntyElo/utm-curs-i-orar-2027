## Courses

One deployment serves several course years at once — `SCHEDULE_COURSES`, `1,2` today. A course year
is a first-class key throughout the stateful half of the app:

```
course 1 ──▶ Schedule (Anul I PDF)  + SourceState + history rows
course 2 ──▶ Schedule (Anul II PDF) + SourceState + history rows
```

The two aggregates are never merged: separate discovery, separate download, separate parse,
separate files (`data/courses/<year>/`), separate `is_current` history row, separate error state.
`src/lib/courses.ts` is the single registry — adding Anul III later is one entry there plus, if a
verified PDF exists, its seed. What *is* shared is the deployment-wide week calendar
(`SCHEDULE_ODD_WEEK_ANCHOR`): FCIM publishes one week-parity announcement for the whole faculty.

Reads are parameterised rather than duplicated: `requireSchedule(courseYear)` and
`buildStatus(courseYear)` are the only course-aware read entry points, and all filtering, sorting
and day handling below them operates on lessons alone.

A course year is only ever accepted, never coerced:

  - **Configuration** is validated at import time. `SCHEDULE_COURSES` / `SCHEDULE_DEFAULT_COURSE`
    must be plain decimal, known, non-duplicated course years, and the default must be one of the
    enabled ones; anything else throws `CourseConfigError` and the process does not start. The
    removed `SCHEDULE_COURSE_YEAR` is a hard stop with a migration message rather than a silent
    ignore.
  - **Public input** is parsed strictly. Only an entirely absent `?course=` means the default; the
    only other accepted values are exactly `1` and `2`. Empty, padded, zero-prefixed, non-numeric,
    unsupported and repeated parameters are 400s. `Number.parseInt` is not used anywhere on a course
    value — it reads `"1x"` as 1, which is the silent resolution all of this exists to prevent.
  - **Internal boundaries** re-check. `assertSupportedCourse` guards every exported storage entry
    point and both read services, and the updater rejects rather than throws (it returns promises).
    An unsupported year can therefore never create a namespace such as `data/courses/3`.

The update coordinator — the serialization queue plus the per-course in-flight map — lives on
`globalThis`, not in module scope. Next.js bundles the instrumentation hook separately from the
route handlers, so this module is evaluated more than once in a single process; module-local state
would give the scheduler and the API separate queues and the serialisation would be a fiction. The
deployment remains single-process: this is shared process state, not a distributed lock.

## How auto-update works

```
every SCHEDULE_REFRESH_MINUTES (default 30) + once at startup
  │
  │  one tick refreshes each supported course in turn; a course that fails keeps its own
  │  last-known-good schedule and its own diagnostics, and the next course is checked anyway
  │
  ├─ GET official page ──(403/timeout)──▶ official WordPress REST page
  │                                      └─(failure)──▶ public Wayback copy (optional)
  │        │
  │        ▼
  │  discover the requested course's PDF link in "Ciclul I … frecvență" (+ academic year,
  │  semester, parity note)
  │  and reject archive pages that do not contain the current academic year
  │        │
  │        ▼
  │  conditional GET (If-None-Match / If-Modified-Since) – HTTPS, allow-listed hosts only,
  │  ≤5 redirects, 20 s timeout, ≤25 MB, "%PDF-" magic check
  │        │
  │        ├─ 304 or same SHA-256 (and same parser version) ─▶ record "unchanged", done
  │        ▼
  │  parse ─▶ course year == requested course ─▶ validate (≥5 groups, all 5 days,
  │           ≥30 lessons, times, geometry, ≤40 % drop vs previous version, uncertain ratio)
  │        │
  │        ├─ ok ─▶ atomic replace: tmp file → fsync → rename  (+ row in PostgreSQL history)
  │        └─ fail ─▶ keep previous schedule, store last_error, result = "rejected"
  │
  ├─ on cold start with no cache and no network ─▶ parse that course's own bundled real FCIM
  │    PDF (source_kind = "seed"); a course without a seed stays unavailable and reports why
  │    └─ if only the remote mirror exists, require its configured SHA-256 before parsing
  │
  └─ persisted seed only + demonstrably newer same-context packaged seed
       └─ parse + validate packaged PDF ─▶ atomically promote seed before discovery
```

An authenticated `POST /api/admin/refresh` may supply one explicit official FCIM timetable PDF
URL when page discovery is unavailable. It joins the same download → hash → parse → validate →
atomic-replace pipeline; it is not a second parser or storage path. Its URL policy is deliberately
stricter than automatic discovery: exact host `fcim.utm.md`, HTTPS, and
`/wp-content/uploads/sites/24/YYYY/MM/*.pdf`, rechecked on every redirect.

Every candidate schedule — live, Wayback, authenticated `manual`, packaged seed, image seed,
repository mirror seed and seed promotion — passes the same gate: `metadata.course_year` must equal
the course year the update was requested for, or it is rejected and nothing is installed. Storage
repeats the check before writing, so no path can put one course's document in another's slot. Each
course ships its own verified seed under `data/seed/`, described by its own per-course settings
(`SCHEDULE_SEED_PDF[_<year>]` and friends), so a cold start behind a blocked source serves that
course's last published timetable; a course whose seed slot holds the wrong document — or nothing —
keeps its storage empty and reports the reason, instead of silently serving another year's
timetable. The parsed course year comes from the PDF's own title
("ANUL UNIVERSITAR 2026/2027, ANUL II, SEMESTRUL III"), which also outranks anything discovery
inferred: a row labelled only by season ("Orar Semestrul de TOAMNĂ") cannot say which semester a
given course year is in, so it is used only when the document carries no title. Discovery derives
that fallback from the course year itself — autumn = semester 2N-1, spring = 2N.

Seed promotion is intentionally asymmetric. A validated packaged seed may replace only a persisted
`source_kind = "seed"` whose parsed academic year, semester, and course year match, and whose
official publication path has an older month/revision. It never replaces `live`, `wayback`, or
authenticated `manual` data. Thus deploying an updated image repairs an obsolete persisted seed
without allowing an older image to roll back a live timetable.

The served schedule provenance and automatic discovery health are separate. An explicit refresh or
seed promotion updates the schedule URL/hash, while a later Cloudflare discovery error remains a
truthful error in SourceState and cannot revert the valid schedule.

`data/courses/<year>/metadata.json` keeps, per course: current PDF URL, SHA-256, ETag,
Last-Modified, last check, last success, last error, last result, academic year / semester, parity
note. A write for one course never touches another's file, cache entry or history row — including
its conditional-request validators, so course 2 activity can never make course 1 answer 304 for a
document it does not have.

A data directory in the pre-multi-course layout (`data/current_schedule.json` + `data/metadata.json`)
is adopted once, by the course whose year the cached schedule declares, and copied into the scoped
layout; the legacy files stay on disk. A legacy cache is never adopted by a course whose metadata
does not match. The legacy `metadata.json` travels only when it demonstrably describes the adopted
schedule — its `current_pdf_hash` must match, or, if it never recorded one, its `current_pdf_url`.
Both files being well-formed proves nothing: an unrelated state would hand the schedule someone
else's ETag and the next check would answer 304 for a document this course does not hold. Unproven
identity means the schedule is adopted bare, with empty conditional metadata.

File writes are serialized per destination path, so two overlapping writers cannot race their
renames onto the same file, and each write uses a unique temporary name (pid + UUID) rather than a
shared one.

Raising `config.parserVersion` invalidates the cache: the next check re-downloads and
re-parses the PDF even when it is byte-identical, so a parser fix reaches users without
waiting for the university to publish a new file.

## The schedule broker (Cloudflare Worker + R2)

FCIM sits behind Cloudflare and answers a container in a datacentre far less reliably than it
answers a Worker at the edge. So an optional broker stands between them: a Worker that mirrors the
official timetable PDFs into immutable R2 snapshots, and stores the accepted state Render produces.

```
FCIM ──▶ Cloudflare Worker ──▶ R2 candidate snapshots ──▶ Render semantic selection /
                                                          parser / validator
                                                                  │
                                                                  ▼
                                              durable accepted state ──▶ local serving state
```

The division of labour is strict and is the reason the broker can stay this simple:

  - **The Worker is a transport.** It mirrors *every* strictly-valid official timetable PDF the
    authoritative page references. It does not read a course year, semester, revision or
    "master vs licență" out of a filename — a filename filter cannot be semantically complete, and
    an incomplete one starves discovery of the very candidate it needed.
  - **Render is the timetable authority.** `discoverPdf(renderedHtml, courseYear)` runs against the
    snapshot's own archived `page-api.json`, so selection is reproducible from the snapshot alone,
    and the file it picks must be present in that snapshot's manifest or the update is rejected.

### Split publication

A Worker on the Cloudflare Free plan gets 10 ms of CPU per invocation. Fetching six PDFs
(~4.3 MB) and closing a snapshot in one invocation measured 11–14 ms, so publication is four
bounded stages, one invocation each, joined by a Cloudflare Queue with a batch size of one:

```
cron (*/20) or authenticated POST /publish   producer-only; enqueue discovery
  │
  ▼
DISCOVERY            one Queue invocation
  ├─ read current.json, parse the strict or exact legacy shape, keep its ETag as the CAS token
  ├─ load legacy Page/PDF validators from that pointer's immutable manifest (never fabricate them)
  ├─ call `FCIM_EGRESS.fetch()` through the private HTTP Service Binding
  ├─ Stockholm backend fetch handler GETs the exact Page API (manual redirect — always refused)
  ├─ unchanged?  modified_gmt equal + same PDF catalogue + every mirrored PDF 304  ──▶ stop
  ├─ write snapshots/<id>/page-api.json          (create-only)
  ├─ write pending/<id>/descriptor.json          (create-only; fixes the expected file set)
  └─ enqueue one ingest job per PDF + a backstop finalize
  │
  ▼
PDF INGEST           one invocation per PDF
  ├─ re-validate the job against the descriptor
  ├─ call the same Service Binding with the descriptor's dynamic official PDF URL
  ├─ Stockholm backend streams the PDF (every redirect is re-checked against the shared policy)
  ├─ stream the body into snapshots/<id>/pdfs/<file>   (create-only, byte-capped)
  ├─ write pending/<id>/completed/<file-id>.json       (create-only)
  └─ enqueue a finalize
  │
  ▼
FINALIZE             one invocation
  ├─ every descriptor file present, every completion marker present?  no ──▶ incomplete, stop
  ├─ write snapshots/<id>/manifest.json          (create-only)
  └─ CAS current.json against the ETag discovery read                  ── LAST
```

`current.json` may name a snapshot only when its `page-api.json`, every descriptor file, every
completion marker and its manifest all exist and agree, so a half-built snapshot is not a risk —
it is simply never pointed at. A cycle that loses the CAS to a newer publisher leaves its snapshot
behind as harmless history rather than overwriting anything.

Every stage is safe to run twice. Snapshot children are created with `If-None-Match: *`, so a
redelivered ingest job either finds its own object already there (success) or finds someone else's
(failure — never an overwrite); a redelivered finalize that sees `current.json` already naming its
snapshot reports success without touching it. Completion is recorded as one immutable marker per
file rather than a shared counter, because two concurrent ingests can lose an update to a counter
and cannot lose disjoint keys.

`fcim-stockholm-egress` is a second, internal-only Worker configured with
`placement.region = "aws:eu-north-1"`, `workers_dev = false`, no route, and no custom domain. The
broker reaches its default fetch handler only through an HTTP Service Binding. Its two private POST
operations permit only the canonical Page API and strict official upload URLs. It forwards only
content type/length, validators, last-modified, and safe placement/ray diagnostics, and returns PDF
bodies as streams. All descriptor, R2, Queue, manifest, CAS, parsing, selection, and accepted-state
responsibilities remain in the broker or Render.

Failures are visible rather than absorbed. The queue processes one message at a time, retries at
most three times, waits 300 seconds between retryable attempts, and sends exhausted messages to
`fcim-broker-publication-dlq`. Network failures and upstream 403, 429 and 5xx responses are
retryable; malformed jobs, invalid immutable state and security-policy rejections are logged and
acknowledged because another attempt cannot change them. A snapshot left unfinished is re-driven
by a reconciliation pass the cron queues each tick, which re-enqueues only the ingest jobs whose
completion markers are missing and whose recorded `current.json` ETag can still win the CAS.
Already-superseded or aged-out SEA-era pending snapshots therefore cause no new FCIM traffic. A
Page API redirect or other deterministic failure is still an
error — the previous `current.json` is left exactly as it was. Only a genuine 304 (or an unchanged
`modified_gmt` with an unchanged catalogue and unchanged PDFs) means "unchanged".

### Accepted state and durable transaction ordering

Accepted state — what Render actually parsed and validated — is stored in two pieces so the Worker
never has to hold a ~200 KB Schedule in memory: an immutable payload streamed straight into R2
under a content-addressed id (`accepted-payloads/course-:year/:acceptedId`), and a small
compare-and-swapped pointer that names it (`accepted/course-:year`). The pointer is written only
after the payload exists and only if every field agrees with the payload's own stored metadata, and
`Content-Length` is treated as a hint — the size limit is enforced on the counted bytes of the
stream, so a chunked upload cannot exceed it.

The broker enforces strict transaction ordering during candidate reconciliation:
1. Render parses and validates the candidate PDF against domain rules.
2. Render writes the immutable payload to R2 first (`PUT /accepted-payloads/course-:year/:acceptedId`).
3. Render writes the pointer with compare-and-swap (`PUT /accepted/course-:year` with `expected_previous_accepted_id`).
4. Only after the durable CAS write succeeds does Render replace its local `current_schedule.json` and `metadata.json`. If the durable write fails or conflicts, local state remains untouched.

The broker's supported course years live in one list (`worker/src/courses.ts`) and every accepted
route re-checks against it: `course-0`, `course-3`, `course-99` and `course-01` are all refused
rather than coerced by `parseInt`.

### Bounded retention, 6-hour lifetime and maintenance cursors

The broker implements bounded, fail-closed retention and garbage collection to operate safely within Free-tier limits:
- **6-hour publication lifetime:** Snapshots in `pending/` older than 6 hours (`PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000`) are considered expired; reconciliation stops re-enqueuing jobs for them.
- **24-hour retention threshold:** Objects in `snapshots/` older than 24 hours (`RETENTION_AGE_MS = 24 * 60 * 60 * 1000`) become eligible for garbage collection.
- **Protected snapshots:** Mark-and-sweep GC strictly protects the currently referenced `current.json` snapshot plus its immediate predecessor chain (`SNAPSHOT_KEEP_PREDECESSORS = 2`). Live data can never be deleted.
- **Maintenance cursors:** Pagination state is maintained in durable R2 cursors (`maintenance/reconcile.json`, `maintenance/gc-pending.json`, `maintenance/gc-snapshots.json`). Sweeps are strictly bounded (`GC_PREFIXES_PER_NAMESPACE = 8`, `GC_MAX_PREFIX_DELETIONS = 4`, `GC_MAX_OBJECTS_PER_PREFIX = 64`, `RECONCILE_SCAN_PAGES = 3`). Cursors are hints; sweeps are strongly consistent and idempotent.

### Degraded mode and upstream 403 behaviour

FCIM upstream Cloudflare challenge responses (HTTP 403), rate limits (HTTP 429), or server errors do not compromise system invariants:
- Publication jobs retry up to 3 times before routing to the DLQ.
- An upstream failure never clears `current.json` or mutates existing candidate snapshots.
- Durable accepted state and local schedules are never deleted or corrupted by upstream outages.
- Render continues serving verified last-known-good schedules from local disk or durable accepted broker state, with fallback to verified bundled seeds during cold starts.

### Production cutover and rollback semantics

The cutover from direct FCIM transport to the broker architecture is designed for zero-downtime, single-instance Render execution:
- **Master activation switch:** `SCHEDULE_BROKER_URL` governs transport selection. When unset, the application executes pre-broker direct transport.
- **Safe rollout order:** Cloudflare infrastructure and worker secrets are aligned before activating the broker on Render.
- **Instant non-destructive rollback:** If an anomaly occurs, unsetting `SCHEDULE_BROKER_URL` on Render immediately reverts the application to direct transport and seed fallbacks without modifying Git history or destroying durable R2 state.

## Odd / even weeks

Half-height cells in the PDF alternate weekly, so every lesson carries `week_parity`
(`odd` / `even` / `both`). The UI counts semester weeks from `SCHEDULE_ODD_WEEK_ANCHOR`
(the Monday of an odd week, `2026-08-31` for autumn 2026/2027) and fades out the lessons
belonging to the other week. Weeks run Monday→Sunday; on Saturday and Sunday the teaching
week is over, so the schedule already shows the week that starts on Monday.

## Architecture

```
┌────────────────────────────── Next.js process ────────────────────────────────┐
│ instrumentation.ts ─┐                                                        │
│ admin/refresh ───────┴─▶ services/updater.ts (queue, scheduler, fallbacks)    │
│                          │  source/discovery.ts   (cheerio, section → link)   │
│                          │  source/downloader.ts  (hardened fetch, SSRF guard)│
│                          ▼                                                    │
│                       parser/                                                 │
│   pdf-extract.ts  text items + fill rects with coordinates (pdf.js)           │
│   geometry.ts     rects → grid lines / backgrounds, enclosingCell()           │
│   table-detector  group columns · day blocks · time-slot rows                 │
│   cell-builder    text → drawn cell → colspan/rowspan → groups[] / slots[]    │
│   lesson-interp.  lines → subject / teacher / room / type / subgroup / parity │
│   normalizer      08:00, "Costaș A.", "D01-03", "0.5 gr."                     │
│   validator       sanity checks (never replace prod data on failure)          │
│   debug.ts        detected_*.json, cells.json, lessons.json, page_debug.svg   │
│                          ▼                                                    │
│                storage/ (data/courses/<year>/{current_schedule,metadata}.json,│
│                          atomic; optional per-course PostgreSQL history)      │
│                          ▼                                                    │
│  app/api/*  health · status · groups · schedule · schedule/{group}[/today]    │
│             source · admin/refresh          (all course-scoped via ?course=)  │
│                          ▼                                                    │
│  components/ScheduleApp (React, course switcher, Today / Week / All groups,   │
│                          search and status, all within the active course)     │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Parser pipeline (per PDF)

1. **Extraction** – every text item with `x0,y0,x1,y1,page` (top-left origin) and every filled
   rectangle with colour. Excel-exported PDFs draw borders as thin fills.
2. **Grid** – fills thinner than 1.5 pt become vertical/horizontal line segments (merged when
   collinear); wider fills are cell backgrounds (grey/orange highlights).
3. **Layout** – header cells matching `^[A-Z]{1,5}-\d{3}` → group columns with X bounds; day labels
   in the left margin (`Luni`, `Marţi`/`Marți`, …) → Y blocks; `8.00-9.30`-style labels inside a
   day → slot rows (`08:00`–`09:30` normalised).
4. **Cells** – for every text item find the nearest drawn borders on 4 sides
   (`enclosingCell`). Items sharing a rectangle form one cell; items on the same baseline form one
   line. The cell rectangle is intersected with column bounds (colspan → `groups[]`) and row
   bounds (rowspan → `slot_span`). Half-height cells map to **odd** (upper) / **even** (lower)
   week; full-height cells are `both`.
5. **Interpretation** – line roles are classified (room pattern, "Surname I." teacher pattern,
   subgroup marker `0,5 gr.`, type prefixes `c.`/`lab`/`sem.`), stacked lessons in one cell are
   split, `Ed. fizică` / `L. Engleză` get their types. Anything else is `unknown` – no guessing.
   Unresolvable cells are kept with `uncertain: true` and the `raw_text`.
6. **Validation** – see above.
