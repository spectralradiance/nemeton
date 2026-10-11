# Nemeton: Project Plan

An offline-first festival and conference schedule app that runs in the browser and installs on phones as a PWA. Attendees can browse the lineup, build a personal itinerary and get live schedule changes. The app keeps working when the venue's network fails, which happens at most festivals.

---

## 1. Goals and non-goals

**Goals**

- The app loads and works fully with no connectivity after the first visit: lineup, schedule, artist details and the user's itinerary.
- First paint comes from local data every time. The network is only used to refresh in the background.
- Official schedule changes (delays, stage moves, cancellations) reach online clients within seconds.
- Itinerary edits are never lost. Edits made offline sync later without the user doing anything.
- The app installs on Android, iOS and desktop.

**Scope decisions**

- **One festival.** The app is built for a single event. The festival is a configuration singleton, not a tenant.
- **Admins are the festival organizers.** In v1 they publish changes through an authenticated admin API, using a small CLI and a JSON import. There's no admin UI until v3.
- **Each itinerary lives on one device in v1.** Cross-device sync comes in v2.

**Non-goals (v1)**

- Native app store builds.
- Ticketing, payments and maps with turn-by-turn directions.
- Push notifications while the app is closed (Web Push). Treated as a stretch goal, see §6.
- Cross-device itinerary sync (v2).
- An admin web interface (v3).

---

## 2. Proposed stack

| Layer      | Choice                                                                | Why                                                                                                                        |
| ---------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Repo       | npm workspaces monorepo: `apps/web`, `apps/server`, `packages/shared` | Client and server share schemas and types                                                                                  |
| Frontend   | Vite + React + TypeScript                                             | Mature ecosystem, first-class `vite-plugin-pwa` support                                                                    |
| PWA / SW   | `vite-plugin-pwa` in **`injectManifest`** mode + Workbox              | Custom SW code is needed for Background Sync. `generateSW` alone is too limiting                                           |
| Local DB   | IndexedDB via **Dexie**                                               | Typed tables, indexes, migrations, and `liveQuery` for reactive UI                                                         |
| Validation | Zod schemas in `packages/shared`                                      | One source of truth for API payloads, IDB records and SSE events                                                           |
| Server     | Node + Hono (or Fastify)                                              | Lightweight. Streaming SSE is easy                                                                                         |
| Server DB  | Postgres (SQLite acceptable for dev and single-event deploys)         | Durable change log with sequence numbers                                                                                   |
| Realtime   | **Server-Sent Events**                                                | Traffic is one-way (server → client), native auto-reconnect with `Last-Event-ID`, proxy-friendly. WebSockets aren't needed |
| Testing    | Vitest + `fake-indexeddb`, Playwright (offline emulation, SW enabled) | Covers sync logic in unit tests and real offline behavior end to end                                                       |

---

## 3. Architecture

```
┌──────────────────────── Browser / installed PWA ─────────────────────────┐
│                                                                          │
│  UI (React) ◄── liveQuery ── Dexie (IndexedDB) ◄──┬── Sync Engine         │
│      │                         ▲                  │   • snapshot/delta   │
│      │ user actions            │                  │   • SSE client       │
│      └──► Outbox (IDB table) ──┘                  │   • outbox flusher   │
│                    │                              │                      │
│  Service Worker    │ (Background Sync 'outbox')   │                      │
│   • precache app shell (Cache-First)              │                      │
│   • runtime cache for images (Cache-First + expiry)                      │
│   • `sync` event → flush outbox                   │                      │
└────────────────────┼──────────────────────────────┼──────────────────────┘
                     │ POST /itinerary/ops          │ GET /schedule/snapshot
                     ▼                              │ GET /schedule/changes?since=N
              ┌──────────────────────────────┐      │ GET /events (SSE)
              │ Server                       │◄─────┘
              │  • schedule change log (seq) │
              │  • itinerary store           │◄── Admin API ◄── organizer CLI (v1) / admin UI (v3)
              └──────────────────────────────┘
```

Two separate caching layers:

- **The Cache Storage API (service worker)** holds _static assets_: the app shell, JS/CSS, fonts, icons and artist images.
- **IndexedDB** holds _data_: the schedule, artists, itinerary and outbox. Schedule JSON is **not** cached in Cache Storage. The app reads it from IDB and refreshes it in the app layer. Caching it in both places would create two sources of truth.

---

## 4. Data model

### Shared (server-authoritative)

The source of truth is the Zod schemas in [packages/shared/src/schema.ts](packages/shared/src/schema.ts). They were shaped by the real organizer spreadsheet (Cascadian Midsummer 2026):

```ts
Festival   { name, timezone /* IANA */, dayBoundaryMinutes, days: [{ date, label }] }  // singleton
Stage      { id, name, order }
Session    { id, kind: 'music'|'ritual'|'workshop', title, subtitle?, tags[] /* "drop-in", "family programming" */,
             day /* festival day */, startsAt /* UTC, null = all day */, endsAt /* UTC, null = not published */,
             stageId, people[] /* workshop facilitators */, origin? /* "Oregon" */,
             description? /* what the session is */, bio? /* who's leading it */, photo?,
             links: [{ kind: 'bandcamp'|'instagram'|'facebook'|'youtube'|'website', url }],
             status: 'scheduled'|'delayed'|'moved'|'cancelled', note? }
Vendor     { id, name, links }
Snapshot   { seq, festival, stages, sessions, vendors }
ChangeLog  { seq /* monotonic */, entity, entityId, op: 'upsert'|'delete', data, at, author /* organizer */ }  // Phase 3
```

What the real data changed from the first draft:

- **No separate Artist table.** In the sheet, each music row _is_ the act, and links sit on the row. The lineup is derived from music sessions. If one act ever plays twice, an Artist table can be added back.
- **End times aren't published.** `endsAt` is nullable. The UI estimates an end (the next start on the same stage, capped at a default length) for the grid layout and clash detection, and shows estimated ends as approximate.
- **"Ongoing" sessions** (drop-in workshops) have no start time and are shown as all-day for their festival day.
- **Vendors** are a first-class list with no times.
- **Bios, photos and links come from the festival website's lineup and workshop pages**, merged into the CSV as extra columns (`website`, `photo`, `subtitle`, `origin`, `description`, `bio`). Links are a list, because one session can have several people's accounts. A link's kind comes from its URL. Photos are hot-linked from Wix's CDN for now. Phase 2 has to decide whether to self-host them, because cross-origin images complicate offline caching (§5.2).

### Per-user (client-authoritative)

```ts
ItineraryItem { userId, sessionId, state: 'added' | 'removed' /* tombstone */,
                updatedAt /* HLC timestamp; only compared in v2, but stamped from v1 */, deviceId }
OutboxOp      { opId /* uuid, idempotency key */, type, payload, createdAt, attempts }
```

### Client-only IDB tables

`festival`, `stages`, `sessions`, `vendors`, `itinerary`, `outbox`, `meta` (`lastSeq`, `lastSyncAt`, `deviceId`, `userId`, `schemaVersion`).

**Time handling:** store everything in UTC and render in the _festival's_ timezone, not the device's. A traveler whose phone is still on home time must not see shifted set times. Sessions that run past midnight belong to the previous "festival day" for grouping, with the day boundary configurable (e.g. 06:00).

---

## 5. Feature design

### 5.1 PWA foundation

- Web app manifest: name, icons (192/512 + maskable), `display: standalone`, theme colors, `start_url`, `scope`.
- iOS extras: `apple-touch-icon` and status-bar meta tags. Show an "Add to Home Screen" hint on iOS, because iOS has no `beforeinstallprompt`. Use a custom install button on Chromium.
- Call `navigator.storage.persist()` after install or first itinerary edit so the browser is less likely to evict IndexedDB. Show storage status in Settings.
- SW update flow: **prompt-to-reload** (`registerType: 'prompt'`), not silent `skipWaiting`. That avoids swapping JS out from under a live session. Bump the IDB schema with Dexie migrations whenever the shell version changes the data shape.

### 5.2 Service worker caching

- **Precache** (Cache-First) everything Vite emits: HTML shell, JS, CSS, fonts, icons. Use a navigation fallback to `index.html` for SPA routes.
- **Runtime cache:** artist images use `CacheFirst` with `ExpirationPlugin` (max ~300 entries, 30 days) and `CacheableResponsePlugin({statuses:[0,200]})`. Watch quota inflation from opaque responses: images should be served same-origin or with CORS.
- **Optional warm-up:** after the first successful snapshot, prefetch images for the user's itinerary artists in the background.
- **API routes:** `NetworkOnly` in the SW. The sync engine owns data freshness and failure handling.

### 5.3 Stale-while-revalidate data loading

On every app start:

1. Render immediately from IDB through `liveQuery`, with no loading spinner if data exists.
2. In the background:
   - If there's no local data, call `GET /schedule/snapshot` (show a skeleton only in this case).
   - Otherwise call `GET /schedule/changes?since={lastSeq}`.
     - `200` returns ordered change entries. Apply them in one Dexie transaction and advance `lastSeq`.
     - `410 Gone` means the log was compacted past `lastSeq`. Fetch the full snapshot and replace the tables atomically.
3. Re-run step 2 on `visibilitychange → visible`, on `online`, and on a slow poll (e.g. every 5 min) as a fallback when SSE isn't connected.
4. Changes appear "silently": the UI updates reactively. _Important_ changes, like a session in the user's itinerary being moved, delayed or cancelled, also show a non-blocking toast and a badge in the "Changes" feed.

### 5.4 Real-time push (SSE)

- `GET /events`. Each event has `id: <seq>` and carries the same change entry shape as the delta endpoint.
- The client tracks `lastSeq`. If an event's `seq !== lastSeq + 1`, it detected a gap and falls back to the delta fetch instead of applying the event.
- Reconnects use the browser's native `Last-Event-ID`. The server replays from the log or tells the client to refetch the snapshot.
- Heartbeat comment every ~25s to keep mobile carriers and proxies from killing idle connections.
- Open the connection only while the page is visible, and close it on `hidden` to save battery. The SSE connection lives in the **page**, not the SW, because browsers terminate idle service workers.

### 5.5 Offline actions and Background Sync

- Every itinerary mutation does two things in **one IDB transaction**:
  (a) apply it locally, so the UI updates instantly
  (b) append an `OutboxOp` with a UUID `opId`
- Flushing: `POST /itinerary/ops` with a batch. The server is idempotent on `opId`, so retries are safe. Remove ops from the outbox only after a 2xx response.
- **Triggers** (layered, because Background Sync isn't available everywhere):
  1. **Background Sync API:** `registration.sync.register('outbox')`. The SW's `sync` handler reads the outbox from IDB and flushes it. This works even after the tab is closed. _Chromium only._
  2. **Fallback for Safari/iOS and Firefox,** which don't support Background Sync: flush on `online`, on `visibilitychange → visible`, on app start, and after each successful SSE connect.
- Exponential backoff on 5xx. Drop and surface 4xx validation errors; don't retry them forever.

### 5.6 Conflict resolution

**Schedule data: server wins.**

- The client never edits schedule entities. The server's change log, ordered by `seq`, is the only source.
- Any local copy is overwritten by a higher-`seq` change. Snapshot replace is atomic.

**Itinerary: client wins.**

- _v1 (one device):_ the device is the only writer, so the client always wins. The outbox is flushed in FIFO order, and the server accepts each op as given. The client never pulls the itinerary back down; IndexedDB is the source of truth.
- Even so, v1 stamps every item and op with a **Hybrid Logical Clock** timestamp and writes removals as tombstones (`state: 'removed'`). That costs almost nothing now and means v2 needs no data migration.
- _v2 (cross-device):_ per-item last-writer-wins on `(userId, sessionId)`. The server applies an op only if its HLC is newer than the stored one, so the latest _user intent_ wins even when it arrives late from an offline device. An HLC tolerates device clock skew far better than raw `Date.now()`. Tombstones stop a delete on one device from being "resurrected" by another device's stale add. Clients pull with `GET /itinerary?since=…`, merge with the same rule, and pending outbox ops beat the server copy until they're flushed.

**Cross-boundary cases** (schedule change affecting itinerary):

- A cancelled session stays in the itinerary, marked "Cancelled", and the user decides whether to remove it. Never silently delete user data.
- If a moved or delayed session now overlaps another itinerary item, show a clash warning.
- If a session is deleted outright, keep the itinerary item as an orphan, shown as "No longer on the schedule".

### 5.7 Identity

- v1 creates an anonymous `userId` + `deviceId` on first launch, and the server issues a signed token. No accounts.
- What server sync gives v1: organizers get anonymous popularity counts per session (useful for crowd planning), and the data is already server-side when v2 arrives. It does **not** restore an itinerary whose IndexedDB was evicted, because the anonymous ID is lost with it. The plan says that plainly instead of promising backup.
- v2 adds cross-device linking with a short pairing code or magic link. It merges two anonymous users through the LWW rules in §5.6 and makes the server copy recoverable.

### 5.8 UI screens

- **Schedule:** a day tab, then a timeline grid by stage. A list view is the default on narrow screens. A "now" line marks the current time, with "on now" and "up next" sections.
- **Lineup:** A–Z list of acts, rituals and workshops, with search and kind/tag filters.
- **Session detail:** time, stage, people, links and an add/remove button.
- **Vendors:** A–Z list.
- **My Itinerary:** chronological list with clash indicators, change badges and an export to `.ics`.
- **Changes feed:** recent official changes, with ones affecting the user highlighted.
- **Settings:** sync status, last updated time, storage persistence, install button and data reset.
- A global offline/sync indicator: "Offline · showing schedule from 14:32" or "3 changes waiting to sync".
- Accessibility: keyboard navigable, color isn't the only stage cue, `prefers-reduced-motion`, readable outdoors (high-contrast theme).

### 5.9 Server and admin

- Public endpoints: `GET /schedule/snapshot`, `GET /schedule/changes?since`, `GET /events` (SSE), `POST /itinerary/ops`. The `GET /itinerary?since` pull endpoint arrives in v2.
- Admin endpoints (organizers only): `POST /admin/changes`, `POST /admin/import`, `GET /admin/stats`. Each organizer gets their own API token, so the change log can record who made each change. Tokens can be revoked individually.
- **v1 organizer tooling is a CLI** (`npm run admin …`) wrapping the admin API:
  - `import schedule.json`: validates and diffs a full schedule against the current one, prints the diff, and publishes it as change-log entries after confirmation.
  - `delay <sessionId> 20m`, `move <sessionId> --stage main --at 21:30`, `cancel <sessionId> --note "…"`: quick fixes for the day of the festival.
  - `log`: shows recent changes and who made them.
  - Every command supports `--dry-run`. Mistakes are fixed by publishing a correcting change, never by rewriting the log.
- Every admin write appends to `ChangeLog` in the same DB transaction as the entity update, then fans out to SSE subscribers. Use in-process pub/sub for one instance, or Postgres `LISTEN/NOTIFY` or Redis when scaled out.
- Snapshots get an `ETag` and are served gzip/brotli, ideally from a CDN.
- Log compaction: keep N days of changes. Older `since` values get `410`.
- v3 adds an admin web UI on top of the same admin API. Nothing on the server has to change for it.

---

## 6. Milestones

Each phase ends with something demoable and its exit criteria.

### Phase 0: Scaffolding ✅ done 2026-10-11

- npm workspaces monorepo, TypeScript, Prettier, a GitHub Actions CI workflow (format, typecheck, unit tests, build). E2E arrives with Phase 2.
- `packages/shared`: Zod schemas, festival-timezone helpers, and a CSV importer for the organizer spreadsheet format (`npm run import:csv`). Real data replaced the planned synthetic generator. The sheet has no AM/PM, so the importer infers it from running order and prints every time it read for a human to check.
- `apps/server`: Hono, `GET /api/schedule/snapshot` with ETag, loaded from `data/seed/festival.json`.
- `apps/web`: Vite + React, placeholder list that loads the snapshot through the dev proxy.
- **Exit met:** `npm run dev` runs both, 14 tests pass, typecheck and build are clean. CI has never run because there's no remote yet.

### Phase 1: Read-only app, online ✅ done 2026-10-11

- Schedule, Lineup, Session detail and Vendors screens rendering from the snapshot, with festival-timezone handling and estimated end times.
- Schedule has day tabs, a kind filter and two layouts: a list grouped by start time, and a "By stage" timeline with sticky stage and hour headers. Both remember the choice per device. During the festival it shows an "On now / Up next" panel, dims sessions that have ended, and draws a now-line on the timeline.
- **Pretend clock for demos:** `?now=2026-06-20T20:40` (festival-local time) sets the clock and keeps it ticking from there. `?now=off`, or the banner's button, resets it.
- Shared logic in `packages/shared/src/schedule.ts`, unit-tested: estimated ends (next start on the same stage, capped at 45 min for music and 60 min for rituals and workshops), the current festival day, on now / up next, and lineup grouping.
- Routing with wouter. A JS bundle of 101 KB gzipped, within budget. Most of it is React and Zod; switching to `zod/mini` on the client would save about 15–20 KB if needed.
- **Exit met:** checked in the browser at 375px and desktop widths, in dark and light themes.

### Phase 2: Offline-first foundation ✅ done 2026-10-11 (real-device install checks pending)

- `vite-plugin-pwa` in injectManifest mode with our own `src/sw.ts`:
  - It precaches the app shell, and every in-app navigation gets the cached `index.html`, so deep links work offline.
  - Photos are cached cache-first, as CORS responses, never opaque ones. Wix sends `Access-Control-Allow-Origin: *`.
  - New versions wait for the user's OK (the "Reload" toast). Registration errors are logged.
- Icons (favicon, 192/512, maskable, Apple touch) are generated from `public/icon.svg` at build time.
- Dexie stores the schedule in `festival`, `stages`, `sessions`, `vendors` and `meta`. Screens render from IndexedDB through `useLiveQuery`, so the network is never on the path to first paint once data exists.
  - Writes replace everything in one transaction.
  - The stored `DATA_VERSION` makes an app update that changes the data shape re-download the schedule instead of misreading it.
- **Interim stale-while-revalidate:** a full snapshot download with `If-None-Match`, run on start, on reconnect, on return to the app and every 5 minutes. It ignores a response with a lower `seq` than what's stored. Phase 3 replaces it with deltas.
- **Settings screen:**
  - Last checked, plus "Check now".
  - "Save all photos now": 44 photos, about 4.7 MB as AVIF.
  - Install: a button on Chromium, instructions on iOS.
  - Storage usage and `storage.persist()`.
  - Clear saved data.
- An "Offline" or "Not updated" chip appears in the header only when something's wrong.
- **Tests:** 8 new unit tests for IndexedDB and sync (with fake-indexeddb). Playwright e2e runs against a production build, with desktop and Pixel 7 profiles: offline hard reload, offline deep links and search, saved photos offline, and an installable manifest. Locally it uses the installed Edge; CI installs Chromium.
- **Bundle:** 137 KB gzipped (Dexie added about 35 KB). It's close to the 150 KB budget, so Phase 3 should consider `zod/mini` on the client.
- `npm run preview` builds and serves the production app on port 5318 with the API. The service worker is off in dev on purpose.
- **Exit:** the offline criteria are met and covered by e2e. Installing on a real Android phone, iPhone and desktop Chrome **still needs a manual check on devices**. The manifest and icons pass the automated installability check.

### Phase 3: Deltas and SWR (≈1 week)

- `ChangeLog` + `seq`, `/changes?since`, `410` → snapshot fallback.
- Background revalidation on start, focus, online and interval. Atomic apply.
- Admin API with per-organizer tokens, and the organizer CLI (`import` with diff, `delay`, `move`, `cancel`, `log`, `--dry-run`).
- **Exit:** a change made with the CLI shows up on a client after its next refresh trigger, without a reload and without UI flicker.

### Phase 4: Real-time SSE (≈4 days)

- `/events` stream, heartbeat, `Last-Event-ID` replay, gap detection, visibility-based connect/disconnect.
- Change toasts and Changes feed.
- **Exit:** an admin edit appears on connected clients in under 2s. Killing and restoring the network resumes without missed changes.

### Phase 5: Itinerary + outbox + Background Sync (≈1.5 weeks)

- Anonymous identity, itinerary UI, clash detection, `.ics` export.
- Outbox, idempotent server ops endpoint, Background Sync in the SW, fallback flush triggers.
- HLC stamping and tombstones (groundwork for v2), plus popularity counts in `GET /admin/stats`.
- **Exit:** the v1 test matrix (§7) passes, including "favorite offline → close tab → reconnect" on Chromium and "favorite offline → reopen app online" on iOS.

### Phase 6: Hardening and polish (≈1 week)

- Schedule changes that affect the itinerary (cancelled/moved/orphaned states).
- Accessibility pass, performance budget, error reporting, schema migration tests.
- Load test SSE fan-out (target: 10k concurrent connections per instance, or document the scaling path).
- **Exit:** performance budget met (below), no critical a11y issues, a migration from the previous schema version passes.

### v2: Cross-device itinerary sync (≈1.5 weeks)

- Device pairing (short code or magic link) and merging anonymous users.
- `GET /itinerary?since` pull, client-side LWW merge, server-side HLC comparison and future-timestamp clamping.
- **Exit:** the v2 conflict matrix (§7) passes across two real devices.

### v3: Admin web interface (≈2 weeks)

- Organizer login using the existing per-organizer tokens or SSO, plus a protected `/admin` route kept out of the attendee PWA bundle.
- Session editor with delay/move/cancel shortcuts, a schedule import with a visual diff, a change log viewer and popularity stats.
- Built only on the existing admin API.

### Stretch (unscheduled)

- Web Push for itinerary-affecting changes while the app is closed (needs VAPID, iOS 16.4+ and an installed PWA).
- Venue map (offline vector tiles), i18n.

---

## 7. Testing strategy

- **Unit (Vitest + fake-indexeddb):** delta apply/rollback, gap detection, HLC ordering, tombstones, outbox FIFO + retry/backoff, festival-day grouping across midnight and DST, CLI schedule diffing. LWW merge tests come in v2.
- **Integration:** server change log + SSE replay against real Postgres (Testcontainers).
- **E2E (Playwright, service workers enabled):**
  - Cold offline load after first visit (`context.setOffline(true)`, reload).
  - Admin change → client updates via SSE. Then disconnect → change → reconnect → change applied via replay.
  - Offline favorite → online → server state reflects it.
  - `410` path: client far behind → snapshot replace.
  - SW update prompt → reload → new version active, data intact.
- **v1 test matrix:**

  | Scenario                                             | Expected                                     |
  | ---------------------------------------------------- | -------------------------------------------- |
  | Add, remove, add again while offline, then reconnect | Server ends at "added", ops applied in order |
  | Same op retried 3× after timeouts                    | Applied once                                 |
  | Organizer cancels a session that's in the itinerary  | Item kept, flagged "Cancelled"               |
  | Organizer deletes a session that's in the itinerary  | Item kept as orphan                          |
  | CLI `import` with a typo'd stage ID                  | Rejected by validation, nothing published    |

- **v2 conflict matrix:**

  | Scenario                                                                      | Expected                        |
  | ----------------------------------------------------------------------------- | ------------------------------- |
  | Device A adds (offline, t1), Device B removes (online, t2 > t1)               | Removed                         |
  | Device A removes (offline, t2), Device B adds (online, t1 < t2), A syncs late | Removed (tombstone wins by HLC) |

- **Manual device checks:** iOS Safari plus an installed iOS PWA, Android Chrome plus installed, and desktop Chrome/Firefox/Safari.

---

## 8. Performance budget

- App shell JS ≤ 150 KB gzipped on initial route.
- Repeat visit: interactive in < 1s on a mid-range Android, from cache + IDB.
- Snapshot payload ≤ 300 KB compressed for a large festival (images excluded and lazy-loaded).
- Delta apply of 100 changes completes in < 50ms with no visible jank.

---

## 9. Risks and platform caveats

| Risk                                                                                | Mitigation                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Background Sync is Chromium-only.** Safari/iOS and Firefox don't support it       | Layered fallback triggers (§5.5). Sync is guaranteed on next open, not while closed                                                                               |
| **iOS can evict storage** for sites that aren't installed after ~7 days without use | Encourage install and request `storage.persist()`. The schedule can always be re-fetched. **In v1 an evicted itinerary is lost.** v2 pairing makes it recoverable |
| Organizer publishes a wrong change on the day                                       | CLI `--dry-run` and diff before publishing, per-organizer audit log, fix by publishing a correcting change                                                        |
| Mobile networks kill idle SSE connections                                           | 25s heartbeat, reconnect with `Last-Event-ID`, poll fallback                                                                                                      |
| Device clock skew corrupts LWW                                                      | Hybrid Logical Clocks. The server can clamp timestamps that are far in the future                                                                                 |
| Bad SW deploy breaks the installed app                                              | Prompt-based updates, versioned caches, a kill-switch SW route documented in the runbook                                                                          |
| Opaque image responses inflate quota                                                | Serve images same-origin or CORS-enabled, and cap the runtime cache                                                                                               |
| SSE fan-out at peak (headliner changes)                                             | Stateless SSE nodes behind pub/sub, and a CDN-cached snapshot for the thundering herd after reconnects                                                            |
| Timezone/DST bugs in set times                                                      | UTC storage, IANA festival timezone, dedicated tests                                                                                                              |

---

## 10. Decisions and open questions

**Decided**

- One festival only. (2026-10-10)
- Admins are the festival organizers. v1 gives them an admin API + CLI, and the admin web UI comes in v3. (2026-10-10)
- Itineraries stay on one device in v1. Cross-device sync comes in v2. (2026-10-10)
- React. (2026-10-11)
- This is a **prototype**. The festivals it might be used for are in **December 2026**. Test data is Cascadian Midsummer 2026 (June). (2026-10-11)
- Organizers keep the schedule in a spreadsheet exported as CSV (format in `data/raw/`). The importer is the start of the CLI's `import` command. (2026-10-11)

**Still open**

1. Hosting: deferred until there's something to show. A single small container with SQLite would cover a prototype.
2. The actual Cascadian Midsummer 2026 dates. The importer assumes Fri 19 – Sun 21 June in `America/Los_Angeles`. Use `--start` to change the date, or to re-base the data onto the current weekend and demo "on now".
3. Real end times or set lengths, if organizers have them. Otherwise ends stay estimated.
4. Expected attendance for the December festivals (sets the SSE load target).
