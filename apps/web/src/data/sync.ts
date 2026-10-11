import { useSyncExternalStore } from 'react';
import { ChangesResponse, SnapshotResponse } from '@nemeton/shared';
import {
  DATA_VERSION,
  OutOfSyncError,
  applyChangesToDb,
  writeSnapshot,
  type NemetonDB,
} from './db';

// Stale-while-revalidate: screens render whatever is in IndexedDB straight away, and this module
// refreshes it in the background by fetching only what changed since the stored seq.

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
    await applyChangesToDb(database, batch);
  } catch (err) {
    if (err instanceof OutOfSyncError) return downloadSnapshot(database, fetchImpl);
    throw err;
  }
  return 'updated';
}

async function downloadSnapshot(database: NemetonDB, fetchImpl: typeof fetch): Promise<SyncResult> {
  const res = await fetchImpl('/api/schedule/snapshot', { cache: 'no-store' });
  if (!res.ok) throw new Error(`The server answered ${res.status}`);
  const { epoch, ...snapshot } = SnapshotResponse.parse(await res.json());
  await writeSnapshot(database, snapshot, epoch);
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
