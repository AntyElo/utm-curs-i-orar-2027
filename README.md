# Orar FCIM UTM

Production-ready timetable web app for FCIM UTM students, built for a **single-instance**
deployment — one container, one data volume (see [Known limitations](#known-limitations)). It
discovers the current PDF of each supported course year on the official page, downloads it,
reconstructs the table **geometrically** (not by regex over linear text), normalises the data,
serves a JSON API and a mobile-first UI, and keeps itself up to date. The last known-good schedule
is never lost because of a network or parsing error.

One deployment serves **Anul I and Anul II** at the same time. Each course year is an independent
aggregate — its own PDF, its own `Schedule`, its own source state, its own history and its own
failure diagnostics — and the two are never merged. The UI opens on Anul I and offers a course
switcher; the API takes `?course=`, defaulting to Anul I when it is omitted.

- Source of truth: <https://fcim.utm.md/procesul-de-studii/orar/> → section
  *"Ciclul I, Licență - învățământ cu frecvență"* → row *"Orar Semestrul …"* → link **Anul I** /
  **Anul II**.
- Automatic discovery does not hard-code a current PDF URL, group list, or lesson. The repository
  also carries one verified real PDF **per course** as a bootstrap/recovery seed.

> **Stack note.** The task brief suggested FastAPI + Vite. This sandbox provides a Next.js runtime,
> so the *same architecture* is implemented as one deployable Next.js app: TypeScript backend
> (route handlers + background scheduler), React frontend, `pdfjs-dist` for coordinate-level PDF
> extraction, `zod` as the strict model layer (Pydantic equivalent), `vitest` for tests. The
> parser is still a staged pipeline with separated modules, and the debug CLI/overlay exists.

Some datails can be found [here](docs/architecture.md ).

---

## Run locally

```bash
npm ci
cp .env.example .env            # adjust if needed
npm run dev                     # http://localhost:3000
```

On first start the app fetches the FCIM page once per supported course, resolves each course's
current PDF, parses them and creates `data/courses/1/current_schedule.json` and
`data/courses/2/current_schedule.json`. Nothing manual is required.

A data directory left over from the single-course era (`data/current_schedule.json` +
`data/metadata.json`) is not discarded: it is adopted once by the course its parsed
`course_year` actually names — in practice Anul I — and copied into the scoped layout. A legacy
cache is never adopted by a course whose metadata does not match, and the original files are left
untouched.

## Run with Docker

```bash
docker build -t fcim-schedule .
docker run -p 8000:8000 fcim-schedule
# → http://localhost:8000
```

`docker compose up --build` does the same with a persistent volume; add `--profile with-db` and
`DATABASE_URL=postgresql://postgres:postgres@db:5432/app_db` to enable the PostgreSQL history.

Debugging and stuff can be found [here](docs/debugging.md ).

## Security

- Automatically discovered PDF URLs require `https` and an allow-listed host (`fcim.utm.md`,
  `utm.md`; `web.archive.org` only for the archive fallback). The authenticated admin recovery
  endpoint accepts only exact-host `fcim.utm.md` URLs under
  `/wp-content/uploads/sites/24/YYYY/MM/*.pdf`; every redirect is checked against that stricter
  policy. Size/timeout/redirect limits apply and the body must start with `%PDF-`.
- No unauthenticated endpoint accepts a URL. React escapes all PDF-derived text.
- Errors are returned as JSON messages; stack traces never reach the client.

## Known limitations

- **Cloudflare.** fcim.utm.md can challenge non-browser clients. The app retries through FCIM's
  official read-only WordPress REST endpoint, then uses the public Wayback copy only as a final
  page-discovery fallback. An archive snapshot from an older academic year is rejected instead of
  being presented as current. If every network source fails and no cache exists, the bundled seed
  remains the last resort; its remote mirror is accepted only when its SHA-256 matches the configured
  official seed, and any candidate whose parsed course year differs from the course being updated is
  refused outright. Each course ships its own verified seed (`data/seed/`), so a cold start with
  discovery blocked serves that course's last published timetable rather than nothing — and never
  another course's: an Anul I PDF offered to Anul II is rejected by the course-year guard, and a
  course with no bundled PDF stays unavailable instead of borrowing one. A newer
  packaged seed may also promote an older persisted seed from the
  exact same academic context, but never live/Wayback/admin-recovered data. Operators can invoke an
  authenticated explicit official-PDF refresh when page discovery is blocked. This does not bypass
  Cloudflare; if the runtime is also challenged for the PDF, the request fails and last-known-good
  data remains served.
- **Lesson type** is only set when the PDF says so (`c.`, `lab`, `sem.`, `Ed. fizică`, `L. …`).
  Most single-group cells in the spring PDF carry no marker → `unknown` (shown as "Tip nespecificat").
- **Week parity.** Each lesson's parity comes from the half-cell convention (upper = odd, lower =
  even). Which parity the *current* week has is computed: the app counts Monday→Sunday weeks from
  `SCHEDULE_ODD_WEEK_ANCHOR` (default `2026-08-31`) and fades out the lessons of the other week.
  That anchor cannot be derived from the PDF – the semester start date is not in it – so it has to
  be set once per semester; the status footer prints the computed week beside the official page's
  own note ("Prima săptămână … este pară/impară") so the two can be cross-checked.
- Free-form notes inside the table (e.g. a lone "SO" or "MCE MCE MCE" banner) are kept as
  `uncertain` lessons with their raw text rather than dropped or guessed.
- Subject abbreviations (MDPS, SDA, AM…) are shown as written; there is no expansion dictionary.
- OCR fallback is not implemented – the official PDFs have a text layer.
- **Single instance.** The refresh scheduler and the in-flight tracking that keeps two checks of the
  same course from overlapping both live in the process, and the cache is a pair of files per course
  under `SCHEDULE_DATA_DIR`.
  Run one replica: two would each download and re-parse the PDF on their own timer, and on a shared
  volume the atomic rename simply decides who wins. There is no distributed lock or leader
  election – for one faculty's timetable it would cost more than it buys. Scale reads with a cache
  or CDN in front of the app rather than with more replicas.

## Deployment

1. Build the image (`docker build -t fcim-schedule .`) or run `npm run build && npm start`.
2. Mount a volume at `/app/data` (Docker) so the cache survives restarts.
3. Set `SCHEDULE_ODD_WEEK_ANCHOR` to the Monday the university counts as week 1 of the semester —
   the week badge and the fading of the other week's lessons are counted from it. It is deliberately
   one calendar for the whole deployment: FCIM publishes a single week-parity announcement.
   `SCHEDULE_COURSES` (default `1,2`) selects which course years are served, and
   `SCHEDULE_DEFAULT_COURSE` (default `1`) the one an API call without `?course=` resolves to.
   Both are validated at startup: a malformed or unknown value stops the process instead of
   silently narrowing the deployment to Anul I, and a leftover `SCHEDULE_COURSE_YEAR` (removed)
   fails with a message naming its replacement.
4. Optionally set `DATABASE_URL` and run `npm run db:migrate` to apply the checked-in migrations in
   `drizzle/`. They create `schedule_versions` on a fresh database and, on one created by the older
   `drizzle-kit push`, add `course_year` (existing rows become Anul I, which is what they are) plus a
   partial unique index enforcing one current version per course. The tooling reads `DATABASE_URL`;
   no connection string is checked in.
5. Set `SCHEDULE_ADMIN_TOKEN` to enable `POST /api/admin/refresh`.
6. Put the container behind HTTPS; `/api/health` is the health check. Run a single replica.

For the authenticated explicit-PDF recovery command and status verification, see
[Cloudflare discovery failures and recovery](docs/debugging.md#cloudflare-discovery-failures-and-recovery).

## Project structure

```
src/app/                 pages + API route handlers
src/components/          React UI (ScheduleApp, DayTimeline, LessonCard, AllGroupsView)
src/lib/config.ts        env-driven configuration
src/lib/courses.ts       supported course years + their seeds (add a course here)
src/lib/models.ts        zod models (Schedule, Lesson, SourceState …)
src/lib/parser/          staged PDF parser + debug overlay
src/lib/source/          discovery + hardened downloader
src/lib/services/        updater (scheduler) + read-side queries
src/lib/storage/         per-course atomic JSON files + optional PostgreSQL history
src/db/                  drizzle schema + course-scoped history queries
src/instrumentation.ts   starts the scheduler with the server
scripts/parser-cli.ts    parse / stats / debug CLI
tests/                   vitest suites + real FCIM fixtures (PDFs, page HTML, regression stats)
data/seed/               bundled real FCIM PDF used only as last-resort bootstrap
.github/workflows/ci.yml typecheck · lint · test · build on every push and PR to main
Dockerfile, docker-compose.yml, Makefile, .env.example
```

## License

The code in this repository is released under the [MIT License](LICENSE).

MIT covers **this project's own source code only**. It does not — and cannot — relicense the
underlying timetable data: the official FCIM/UTM schedule PDFs, everything parsed out of them, the
archived copy of the official schedule page, and the real PDFs committed under `data/seed/` and
`tests/fixtures/` remain the property of Universitatea Tehnică a Moldovei. They are redistributed
here purely so the app can bootstrap without network access and so the parser's regression fixtures
stay reproducible. If you fork this project, the MIT grant travels with the code; the schedule data
does not.

Provenance of the committed copies, all retrieved from the official source:

| File | Origin | Role |
| --- | --- | --- |
| `data/seed/anul_i_semestrul_i-18.pdf` | `fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_i_semestrul_i-18.pdf` | Anul I cold-start seed (SHA-256 `a4c610d2…b79a`) |
| `data/seed/anul_ii_semestrul_iii-11.pdf` | `fcim.utm.md/wp-content/uploads/sites/24/2026/09/anul_ii_semestrul_iii-11.pdf` | Anul II cold-start seed (SHA-256 `3728f5ab…a23b`) |
| `tests/fixtures/anul_i_semestrul_i-16.pdf`, `anul_ii_semestrul_iii-10.pdf` | same host, the previously shipped seeds | seed-promotion & repair fixtures: the persisted revision each course is promoted *from*, test-only |
| `tests/fixtures/anul_i_semestrul_i-{3,5,9}.pdf`, `anul_ii_semestrul_iii-8.pdf`, `anul_i_semestrul_ii-1.pdf` | same host, earlier publications | parser regression fixtures, test-only |
| `tests/fixtures/orar-page-autumn-2026.html`, `orar-page.html` | `fcim.utm.md/procesul-de-studii/orar/` | discovery fixtures, test-only |

Nothing under `tests/` is loaded at runtime or shipped in the container image (see
`.dockerignore`). `data/seed/` holds exactly the two PDFs the deployment actually serves — one per
course — so the image ships no revision it would never install. A superseded seed is not deleted:
it moves to `tests/fixtures/`, where it keeps proving that a volume still holding that older
revision is promoted forward to the packaged one. A seed is only ever a fallback — the live PDF
discovered on the official page always wins, and a seed is never installed for a course whose year
it does not match.
