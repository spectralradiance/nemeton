import { useSyncExternalStore } from 'react';
import { ChangesResponse, SnapshotResponse } from '@nemeton/shared';
import {
  DATA_VERSION,
  OutOfSyncError,
  addToFeed,
  applyChangesToDb,
  writeSnapshot,
  type FeedItem,
  type NemetonDB,
} from './db';

// Keeps the IndexedDB copy of the schedule current. Screens render from IndexedDB and never wait
// on the network. Three ways changes arrive, all applied the same gap-checked way:
//   1. Live: a Server-Sent Events stream pushes each batch as organizers publish it.
//   2. Catch-up: on start, reconnect and return to the app, fetch changes since the stored seq.
//   3. Fallback: poll every 5 minutes, in case the stream is silently broken.

export type SyncResult = 'updated' | 'unchanged';

export interface SyncStatus {
  syncing: boolean;
  online: boolean;
  /** The live stream is connected, so changes arrive within seconds. */
  live: boolean;
  /** Message from the last failed attempt, cleared by the next success. */
  error: string | null;
}

let status: SyncStatus = {
  syncing: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  live: false,
  error: null,
};
const statusListeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l());
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      statusListeners.add(l);
      return () => statusListeners.delete(l);
    },
    () => status,
  );
}

// ---------- change notifications (for toasts) ----------

const changeListeners = new Set<(items: FeedItem[]) => void>();

/** Called with the session changes applied by each update this device receives. */
export function onScheduleChanged(listener: (items: FeedItem[]) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function announce(items: FeedItem[]) {
  if (items.length > 0) changeListeners.forEach((l) => l(items));
}

// ---------- catch-up and full download ----------

/**
 * Brings the stored schedule up to date. Normally fetches only the changes since the stored seq;
 * downloads the whole schedule when there's nothing stored, the server says the gap can't be
 * bridged (410), or a batch doesn't line up with what's stored.
 */
export async function syncSchedule(
  database: NemetonDB,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult> {
  const meta = await database.meta.get('sync');
  if (!meta || meta.dataVersion !== DATA_VERSION) return downloadSnapshot(database, fetchImpl);

  const params = new URLSearchParams({ since: String(meta.seq), epoch: meta.epoch });
  const res = await fetchImpl(`/api/schedule/changes?${params}`, { cache: 'no-store' });
  if (res.status === 410) return downloadSnapshot(database, fetchImpl);
  if (!res.ok) throw new Error(`The server answered ${res.status}`);

  const batch = ChangesResponse.parse(await res.json());
  if (batch.changes.length === 0) {
    await database.meta.update('sync', { syncedAt: Date.now() });
    return 'unchanged';
  }
  try {
    announce(await applyChangesToDb(database, batch));
  } catch (err) {
    if (!(err instanceof OutOfSyncError)) throw err;
    // The live stream may have applied the same changes meanwhile; that's fine.
    const now = await database.meta.get('sync');
    if (now?.epoch === batch.epoch && now.seq >= batch.to) return 'updated';
    return downloadSnapshot(database, fetchImpl);
  }
  return 'updated';
}

/** How much history to show in the Updates feed after a fresh download. */
const HISTORY = 50;

async function downloadSnapshot(database: NemetonDB, fetchImpl: typeof fetch): Promise<SyncResult> {
  const res = await fetchImpl('/api/schedule/snapshot', { cache: 'no-store' });
  if (!res.ok) throw new Error(`The server answered ${res.status}`);
  const { epoch, ...snapshot } = SnapshotResponse.parse(await res.json());
  await writeSnapshot(database, snapshot, epoch);
  await database.feed.clear();

  // Recent official changes, so the Updates feed isn't empty on a new device. Best effort.
  try {
    const since = Math.max(0, snapshot.seq - HISTORY);
    const params = new URLSearchParams({ since: String(since), epoch });
    const history = await fetchImpl(`/api/schedule/changes?${params}`, { cache: 'no-store' });
    if (history.ok) {
      const { changes } = ChangesResponse.parse(await history.json());
      await addToFeed(
        database,
        changes
          .filter((c) => c.entity === 'session')
          .map((c) => ({
            seq: c.seq,
            at: c.at,
            sessionId: c.id,
            op: c.op,
            after: c.op === 'upsert' ? snapshot.sessions.find((s) => s.id === c.id) : undefined,
          })),
      );
    }
  } catch {
    // The schedule itself is stored; missing history only leaves the feed shorter.
  }
  return 'updated';
}

let inFlight: Promise<SyncResult> | null = null;

/** Runs a sync unless one is already running, recording the outcome in the shared status. */
export function requestSync(database: NemetonDB): Promise<SyncResult> {
  inFlight ??= (async () => {
    setStatus({ syncing: true });
    try {
      const result = await syncSchedule(database);
      setStatus({ error: null });
      return result;
    } catch (err) {
      setStatus({ error: navigator.onLine ? (err as Error).message : 'You are offline' });
      throw err;
    } finally {
      setStatus({ syncing: false });
      inFlight = null;
    }
  })();
  return inFlight;
}

// ---------- live stream ----------

/**
 * Applies one pushed batch. Skips batches already applied (e.g. by a catch-up fetch), and falls
 * back to a catch-up fetch when a batch doesn't follow on from what's stored (a gap).
 */
export async function handleLiveBatch(
  database: NemetonDB,
  raw: unknown,
  catchUp: () => Promise<unknown> = () => requestSync(database),
): Promise<'applied' | 'duplicate' | 'gap'> {
  if (inFlight) await inFlight.catch(() => {});
  const batch = ChangesResponse.parse(raw);
  const meta = await database.meta.get('sync');
  if (!meta || meta.dataVersion !== DATA_VERSION || meta.epoch !== batch.epoch) {
    await catchUp();
    return 'gap';
  }
  if (batch.to <= meta.seq) return 'duplicate';
  if (batch.from !== meta.seq) {
    await catchUp();
    return 'gap';
  }
  try {
    announce(await applyChangesToDb(database, batch));
    return 'applied';
  } catch (err) {
    if (!(err instanceof OutOfSyncError)) throw err;
    await catchUp();
    return 'gap';
  }
}

/** Opens the event stream while the app is visible and online; closes it otherwise. */
function startLiveStream(database: NemetonDB) {
  let source: EventSource | null = null;
  let opening = false;

  async function connect() {
    if (source || opening || typeof EventSource === 'undefined') return;
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    opening = true;
    try {
      const meta = await database.meta.get('sync');
      // Nothing stored yet: the first download comes from requestSync, which calls connect() again.
      if (!meta || meta.dataVersion !== DATA_VERSION) return;
      const params = new URLSearchParams({ since: String(meta.seq), epoch: meta.epoch });
      const es = new EventSource(`/api/events?${params}`);
      es.addEventListener('open', () => setStatus({ live: true }));
      // The browser reconnects by itself, resuming from the last event id.
      es.addEventListener('error', () => setStatus({ live: false }));
      es.addEventListener('changes', (e) => {
        void handleLiveBatch(database, JSON.parse((e as MessageEvent).data)).catch(() => {});
      });
      es.addEventListener('reset', () => {
        disconnect();
        void requestSync(database)
          .catch(() => {})
          .then(connect);
      });
      source = es;
    } finally {
      opening = false;
    }
  }

  function disconnect() {
    source?.close();
    source = null;
    setStatus({ live: false });
  }

  return { connect, disconnect };
}

// ---------- wiring ----------

const POLL_MS = 5 * 60_000;

/** Starts live updates plus catch-up on start, reconnect and return to the app, and polling. */
export function startBackgroundSync(database: NemetonDB): () => void {
  const live = startLiveStream(database);
  const run = () =>
    void requestSync(database)
      .catch(() => {})
      .then(live.connect);

  const onVisibility = () => {
    if (document.visibilityState === 'visible') run();
    // Close the stream in the background: saves battery, and catch-up covers the gap on return.
    else live.disconnect();
  };
  const onOnline = () => {
    setStatus({ online: true });
    run();
  };
  const onOffline = () => {
    setStatus({ online: false });
    live.disconnect();
  };

  run();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  const timer = setInterval(() => document.visibilityState === 'visible' && run(), POLL_MS);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    clearInterval(timer);
    live.disconnect();
  };
}
