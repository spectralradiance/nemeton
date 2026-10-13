# Nemeton

An offline-first festival schedule that installs on phones as a PWA. Built as a prototype with
Cascadian Midsummer 2026 data. See [PLAN.md](PLAN.md) for the design and roadmap.

## Getting started

Needs Node 24 (it uses the built-in `node:sqlite`).

```bash
npm install
npm run dev          # API on :8787, web app on :5317
```

The first server start creates `data/nemeton.db` from `data/seed/festival.json`.

| Command                    | What it does                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `npm run dev`              | API + web app with hot reload. The service worker is off in dev.                            |
| `npm run preview`          | Production build on :5318 with the service worker, for trying offline behavior              |
| `npm test`                 | Unit tests (Vitest)                                                                         |
| `npm run test:e2e`         | Browser tests against a production build: offline, deltas, photos. Uses the installed Edge. |
| `npm run typecheck`        | TypeScript across all packages                                                              |
| `npm run import:csv`       | Rebuild `data/seed/festival.json` from the organizer CSV in `data/raw/`                     |
| `npm run db:reset`         | Delete the database so the next server start re-seeds it                                    |
| `npm run load:sse -- 5000` | Load-test live updates with N connections against a throwaway server                        |

**Demo clock:** add `?now=2026-06-20T20:40` to any URL to pretend it's that festival-local time
(`?now=off` resets it). This shows "On now", the now-line and dimmed past sets with past data.

## Attendee plan

Attendees save sessions to **My plan** with no account. The plan is stored on the device, works
offline and syncs to the server in the background, through Background Sync on Chromium even after
the app is closed. It flags clashes and organizer changes to saved sessions, and exports to a
calendar (`.ics`). The server only learns anonymous counts, which organizers see with `stats`.

## Organizer CLI

Organizers change the live schedule from the command line. Apps that are open and online get
each change within a couple of seconds over a live connection, with a toast and an entry in the
Updates tab. Others catch up when they're next opened or back online.

```bash
# Once, on the server: create an organizer. The token is shown only once.
npm run admin -- organizer add "Alex Organizer"

# Then, anywhere that can reach the server:
export NEMETON_TOKEN=nmt_…              # and NEMETON_API if it's not http://localhost:8787
npm run admin -- delay hail-fri 20m --note "Generator trouble"
npm run admin -- move fauna-sun --stage "Stage 2" --at 00:30
npm run admin -- cancel "rewilding" --note "Cancelled due to high winds"
npm run admin -- restore rewilding-the-selkie-sun
npm run admin -- import data/raw/cascadian-midsummer-2026.csv
npm run admin -- log
npm run admin -- stats               # which sessions attendees saved most (anonymous counts)
npm run admin -- errors --stack      # crash reports from attendees' apps
```

- Every change shows exactly what will change and asks before publishing. `--dry-run` only
  shows it, and `--yes` skips the question (for scripts).
- Sessions can be named by id or by a unique part of the title.
- `--at` takes festival-local 24-hour times. Times before the day boundary (06:00) mean that
  night, so `--at 00:30` on Sunday is Monday 12:30 AM.
- `import` publishes only the differences between the spreadsheet and the live schedule. It warns
  if that would undo a delay, move or cancellation made on the day.
- If someone else published in the meantime, the server refuses the change. Run the command
  again to review the new state.

Run `npm run admin -- --help` for everything.
