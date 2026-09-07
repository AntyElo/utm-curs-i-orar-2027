## API

Every read endpoint below except `/api/health` takes an optional `course` parameter selecting the
course year. Parsing is strict: **omitting the parameter entirely** means course 1, so a
pre-multi-course client keeps working unchanged, and the only other accepted values are exactly `1`
and `2`. Everything else is a `400` carrying `supported_courses` — including `course=` (present but
empty), whitespace, `01`, `1.0`, `1x`, `0`, `-1`, `3`, and a repeated `course` parameter. A request
this deployment cannot answer is never answered with another course's data.

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | deployment liveness: `ok` (process up), `has_schedule` (any course has data), `courses[]` (per-course availability) |
| `GET /api/status?course=1` | that course's schedule stats + updater state (last check, last error, result), plus `supported_courses` |
| `GET /api/groups?course=2` | groups of that course's PDF with lesson counts |
| `GET /api/schedule?course=2&group=SI-251&day=Luni&teacher=&subject=&room=&q=` | filtered lessons of that course |
| `GET /api/schedule/{group}?course=2` | one group, grouped `by_day`. The course comes from the query string: group names are unique inside a course, not across the faculty |
| `GET /api/schedule/{group}/today?course=2` | today's lessons (Europe/Chisinau) |
| `GET /api/source?course=2` | provenance: current PDF URL, hash, ETag, discovery kind |
| `POST /api/admin/refresh[?force=1]` | authenticated maintenance re-check. JSON `course` selects the course year and is **required** whenever `pdf_url` is supplied; omitted on a plain discovery refresh it means course 1. Optional `pdf_url` selects a strictly validated official FCIM timetable PDF |

`/api/health` deliberately reports no per-course error text: `ok` stays true while the process is
serving, so an orchestrator does not restart a container over one broken timetable. A single course's
diagnostics live in `/api/status?course=N`.

## Cloudflare discovery failures and recovery

FCIM may return a Cloudflare Challenge Page to automated requests for both the rendered timetable
page and its WordPress REST representation. The updater reports this as an error in
`GET /api/status` (`source.last_result`, `source.last_error`, and `source.last_error_at`) and keeps
serving the last known-good schedule. A discovery failure does not delete, empty, or roll back the
current schedule.

After deployment, first inspect schedule freshness and discovery health separately:

```bash
curl -fsS https://utm-curs-i-orar-2027.onrender.com/api/status | jq '{schedule, source}'
```

If automatic HTML discovery is unavailable, an administrator may ask the existing refresh endpoint
to download one known official PDF directly. `SCHEDULE_ADMIN_TOKEN` must be configured, and the URL
must name the course being recovered, use HTTPS, the exact host `fcim.utm.md`, and this path form:
`/wp-content/uploads/sites/24/YYYY/MM/*.pdf`. Redirects are followed only while every destination
still satisfies that same policy. The response must be a bounded PDF body beginning with `%PDF-`;
HTML and Cloudflare challenge responses are rejected.

```bash
export APP_URL=https://utm-curs-i-orar-2027.onrender.com
export COURSE=1
export PDF_URL=https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf
curl -fsS -X POST "$APP_URL/api/admin/refresh" \
  -H "Authorization: Bearer $SCHEDULE_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "{\"pdf_url\":\"$PDF_URL\",\"force\":true}" | jq .
curl -fsS "$APP_URL/api/status" | jq '{schedule: {source_pdf_url: .schedule.source_pdf_url, source_pdf_hash: .schedule.source_pdf_hash, groups: .schedule.groups, lessons: .schedule.lessons, source_kind: .schedule.source_kind}, discovery: {last_result: .source.last_result, last_error: .source.last_error}}'
```

Success means the served `schedule` has the requested URL/hash/counts. `source.last_error` may still
show the last automatic discovery failure; explicit recovery does not falsely mark HTML discovery
as healthy. This is an authenticated fallback, not the normal update path, and it does not bypass
or solve Cloudflare challenges. If the hosting runtime cannot fetch the static PDF either, the
request fails safely and the previous schedule remains available.

## Testing the parser manually

```bash
npm run parser -- parse tests/fixtures/anul_i_semestrul_ii-1.pdf --json out.json   # schedule.json + stats
npm run parser -- stats some-other.pdf                                             # only statistics
npm run parser -- debug some-other.pdf --output debug/                             # debug artefacts
npm test                                                                           # vitest suite
```

`stats` prints groups, lessons, lessons per group, per type, merged cells, uncertain entries and
the validation verdict. Exit code 1 if validation fails. Use it to check any new PDF before it is
published.

### Debugging PDF geometry

`debug/` contains:

- `detected_groups.json` – group columns with X bounds
- `detected_days.json` – day blocks and time-slot rows with Y bounds
- `cells.json` – reconstructed cells (lines, groups, slots, background colour)
- `orphans.json` – text inside the table that mapped to no group/slot (should be empty)
- `lessons.json` – final lessons
- `page_debug.svg` – overlay: blue = group column boundaries + labels, orange dashed = slot rows,
  coloured blocks = days, green boxes = lessons, purple = merged (multi-group) lessons,
  red = uncertain, orange dashed = orphans. Open it in a browser; hover a box for details.

## schedule.json

```jsonc
{
  "metadata": {
    "academic_year": "2026/2027", "semester": "Semestrul I", "course_year": 1,
    "source_page_url": "https://fcim.utm.md/procesul-de-studii/orar/",
    "source_pdf_url": "https://fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf",
    "source_pdf_hash": "sha256…", "source_kind": "live | wayback | seed | manual",
    "downloaded_at": "…", "parsed_at": "…", "parser_version": "1.3.0",
    "etag": null, "last_modified": null, "pdf_title": "ANUL UNIVERSITAR 2026/2027, ANUL I, SEMESTRUL I"
  },
  "groups": [{ "name": "SI-261", "program": "SI", "x0": 52.6, "x1": 79.8 }],
  "days": ["Luni", "Marți", "Miercuri", "Joi", "Vineri"],
  "time_slots": [{ "index": 0, "start_time": "08:00", "end_time": "09:30", "raw": "8.00-9.30" }],
  "lessons": [{
    "id": "3f2a…", "day": "Luni", "slot_index": 2, "slot_span": 1,
    "start_time": "11:30", "end_time": "13:00",
    "groups": ["TI-251", "TI-252", "TI-253"],
    "subject": "Matematica Discretă și Probabilitatea Statistică", "teacher": "Leahu A.", "room": "6-2",
    "lesson_type": "lecture", "subgroup": null, "week_parity": "both",
    "notes": [], "raw_text": "c. Matematica Discretă … | Leahu A. | 6-2",
    "geometry": { "page": 1, "x0": 43.8, "y0": 195.7, "x1": 207.8, "y1": 211.6 },
    "confidence": 0.95, "uncertain": false
  }],
  "warnings": []
}
```

`lesson_type` ∈ lecture · lab · seminar · practice · physical_education · language · project ·
unknown. `week_parity` ∈ odd · even · both · unknown.

## Environment variables

See `.env.example`. Key ones: `SCHEDULE_PAGE_URL`, `SCHEDULE_REFRESH_MINUTES` (30),
`SCHEDULE_COURSES` (1,2), `SCHEDULE_DEFAULT_COURSE` (1), `SCHEDULE_ODD_WEEK_ANCHOR` (Monday of an odd week – set once per
semester), `SCHEDULE_ALLOWED_HOSTS`, `SCHEDULE_WORDPRESS_FALLBACK`,
`SCHEDULE_WAYBACK_FALLBACK`,
`SCHEDULE_HTTP_TIMEOUT_MS`, `SCHEDULE_MAX_REDIRECTS`, `SCHEDULE_MAX_PDF_MB`, `SCHEDULE_DATA_DIR`,
`SCHEDULE_SEED_PDF`, `SCHEDULE_SEED_PDF_URL`, `SCHEDULE_SEED_PDF_MIRROR_URL`,
`SCHEDULE_SEED_PDF_SHA256` (Anul I) and the same four with `_2` appended (Anul II),
`DATABASE_URL` (optional), `SCHEDULE_ADMIN_TOKEN`, `SCHEDULE_DISABLE_SCHEDULER`, `LOG_LEVEL`.

Course configuration is validated at startup and the process refuses to boot on a bad value rather
than falling back to course 1: `SCHEDULE_COURSES` must be a comma-separated list of known course
years (`1`, `2`) with no empty, padded, zero-prefixed or duplicated entries, and
`SCHEDULE_DEFAULT_COURSE` must name exactly one course that `SCHEDULE_COURSES` enables. The removed
`SCHEDULE_COURSE_YEAR` is also a hard stop: if it is still set, startup fails with a message naming
its replacement instead of quietly serving a different set of courses than the operator configured.

Seed settings are per course and never shared: course 1 keeps the historical unsuffixed names and
every other course appends `_<year>`, so `SCHEDULE_SEED_PDF_2` can only describe Anul II. Both
courses ship a verified PDF under `data/seed/`, which the Docker image also copies to `/app/seed` so
a mounted (initially empty) `/app/data` volume cannot hide it. A seed is a cold-start fallback only —
the live PDF discovered on the official page always wins — and it is still subject to the course-year
guard, so an Anul I document placed in Anul II's seed slot is rejected rather than installed.

`SCHEDULE_SEED_PDF_SHA256` pins only the remote mirror fallback. If an operator changes the mirror
or the official provenance URL, they must set this value to the SHA-256 of the intended mirror
bytes. Local packaged seed overrides continue through the normal parser and validator without
requiring this mirror-specific pin.

## PostgreSQL history schema

The optional history store is versioned by checked-in migrations under `drizzle/`, applied against
whatever `DATABASE_URL` points at — there is no hard-coded connection string.

```bash
DATABASE_URL=postgresql://user:pass@host:5432/db npm run db:migrate
```

| Migration | What it does |
| --- | --- |
| `0000_single_course_baseline` | the pre-multi-course table, `CREATE TABLE IF NOT EXISTS` so a database created by the old `drizzle-kit push` adopts the journal without losing history |
| `0001_multi_course_scoping` | adds `course_year` (`DEFAULT 1 NOT NULL`, which backfills existing rows as Anul I — the course they actually describe), retires any duplicate current row per course, then adds a **partial unique index** on `course_year WHERE is_current` plus a `(course_year, created_at DESC)` lookup index |

The partial unique index makes "one current version per course" a database invariant instead of a
promise the application sequencing makes: two writers racing on the same course cannot both leave an
`is_current` row behind. Authoring a new migration is `npm run db:generate` (offline, no URL needed).
