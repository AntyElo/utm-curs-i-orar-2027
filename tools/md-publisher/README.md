# MD Publisher

Transport-only FCIM timetable publisher for the Moldova laptop.

It fetches the official FCIM Page API and the timetable PDFs it references, and uploads those raw
bytes to the schedule broker. It parses nothing, decides nothing, and cannot write accepted state.
See [`docs/gate-f-md-publisher.md`](../../docs/gate-f-md-publisher.md) for the full trust model,
API contract and operational envelope.

## Install

```powershell
cd tools\md-publisher
npm run build
```

Set the environment for the account that will run it:

```powershell
setx MD_PUBLISHER_BROKER_URL "https://<broker-host>"
setx MD_PUBLISHER_TOKEN      "<publisher token, at least 32 characters>"
```

`MD_PUBLISHER_TOKEN` must differ from the broker's `SCHEDULE_BROKER_SECRET`; if they match, the
broker refuses every publisher route.

`setx` persists the token in this user's environment — that is, in `HKCU\Environment` — which is
what lets the scheduled task run unattended. The publisher itself only reads it from the process
environment and never writes it into its state directory, its heartbeat or its log lines, and the
broker never logs or stores it either; but on this laptop the value is at rest under that account,
so treat it as a user secret. Install it under the account that runs the task and no other. The
token is intentionally low-privilege: it grants the publisher routes only, and cannot write
accepted state or influence what the broker derives.

Register the scheduled task. The logon model is explicit and has no fallback:

```powershell
.\install-task.ps1 -LogonMode Interactive
```

or, only if the task must run before anyone logs on:

```powershell
.\install-task.ps1 -LogonMode Password -User "MACHINE\account"
```

S4U is not supported. An existing S4U task is never overwritten silently.

## Commands

```powershell
node .\dist\tools\md-publisher\src\index.js publish            # the normal scheduled command
node .\dist\tools\md-publisher\src\index.js publish --dry-run  # decide and report; read-only
node .\dist\tools\md-publisher\src\index.js check              # upstream drift only; read-only
node .\dist\tools\md-publisher\src\index.js status             # broker operational state
node .\dist\tools\md-publisher\src\index.js doctor             # config, state dir, task logon model
```

There is no `--force`. A run that finds nothing to do is a success.

`--dry-run` and `check` are read-only, not broker-free. Both issue broker `GET`s —
`current.json`, and the current snapshot's `manifest.json` and `page-api.json` — because that
snapshot is what "unchanged" is measured against, and both then run the FCIM checks that
comparison needs. Neither opens a publication, uploads anything, completes anything, writes
accepted state or sends a heartbeat: no broker mutation at all.

`--dry-run` also leaves a resumable attempt in `run/` exactly as it found it, and reports the
operation id it would resume; observing is not a reason to throw pending work away. Both commands
may clear the transient `cache/` directory, which is disposable by construction.

Exit codes: `0` for `unchanged`, `published`, `superseded` and `dry_run`; `1` for a failed run;
`2` for a usage or configuration error.

## Local state

`MD_PUBLISHER_STATE_DIR` (default `%LOCALAPPDATA%\fcim-md-publisher`):

```
config.json           optional defaults; logon_model is written by install-task.ps1
state/last-run.json   cached baseline; used only while it names the broker's current snapshot
run/operation.json    the attempt in flight
run/page.json         the exact page bytes that attempt was opened with
run/tmp/, cache/      transient PDF bodies, removed as soon as they are uploaded
```

None of it is required for correctness. **The only authoritative freshness baseline is the snapshot
the broker's `current.json` names**; `last-run.json` is a cache of that snapshot's own manifest and
is ignored outright unless its `broker_snapshot_id` is the one the broker is serving right now.

Deleting the whole directory is safe, and so is starting from a fresh clone on a different laptop:
the next run rebuilds the baseline from the broker and converges. The cost is one extra pair of
reads, or at worst one extra publication — never lost freshness.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run build        # emits dist/
```

Tests live with the rest of the repository suite and run from the repository root
(`npx vitest run tests/gate-f-md-publisher.test.ts`). They drive the real publisher against the
real broker Worker over an in-process transport; no test contacts FCIM.
