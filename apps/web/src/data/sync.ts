import { useSyncExternalStore } from 'react';
import { Snapshot } from '@nemeton/shared';
import { DATA_VERSION, writeSnapshot, type NemetonDB } from './db';

// Stale-while-revalidate: screens render whatever is in IndexedDB straight away, and this module
// refreshes it in the background. Phase 3 swaps the full download for deltas (/changes?since=seq).

export type SyncResult = 'updated' | 'unchanged';

export interface SyncStatus {
  syncing: boolean;
  online: boolean;
  /** Message from the last failed attempt, cleared by the next success. */
  error: string | null;
}

let status: SyncStatus = {
  syncing: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  error: null,
};
const listeners = new Set<() => void>();

function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

/**
 * Fetches the snapshot if it changed since the stored ETag, and stores it.
 * Server wins for schedule data, but a response older than what's stored (lower seq) is ignored.
 */
export async function syncSnapshot(
  database: NemetonDB,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult> {
  const meta = await database.meta.get('sync');
  const current = meta?.dataVersion === DATA_VERSION ? meta : undefined;
  const res = await fetchImpl('/api/schedule/snapshot', {
    headers: current?.etag ? { 'If-None-Match': current.etag } : {},
    cache: 'no-store',
  });

  if (res.status === 304 && current) {
    await database.meta.update('sync', { syncedAt: Date.now() });
    return 'unchanged';
  }
  if (!res.ok) throw new Error(`The server answered ${res.status}`);

  const snapshot = Snapshot.parse(await res.json());
  if (current && snapshot.seq < current.seq) return 'unchanged';
  await writeSnapshot(database, snapshot, res.headers.get('etag'));
  return 'updated';
}

let inFlight: Promise<SyncResult> | null = null;

/** Runs a sync unless one is already running, recording the outcome in the shared status. */
export function requestSync(database: NemetonDB): Promise<SyncResult> {
  inFlight ??= (async () => {
    setStatus({ syncing: true });
    try {
      const result = await syncSnapshot(database);
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

const POLL_MS = 5 * 60_000;

/** Keeps the stored schedule fresh: on start, on reconnect, on return to the app, and every 5 min. */
export function startBackgroundSync(database: NemetonDB): () => void {
  const run = () => void requestSync(database).catch(() => {});
  const onVisible = () => document.visibilityState === 'visible' && run();
  const onOnline = () => {
    setStatus({ online: true });
    run();
  };
  const onOffline = () => setStatus({ online: false });

  run();
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  const timer = setInterval(() => document.visibilityState === 'visible' && run(), POLL_MS);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    clearInterval(timer);
  };
}
