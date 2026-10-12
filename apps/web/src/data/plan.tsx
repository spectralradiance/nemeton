import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type ItineraryItem } from './db';
import { OutboxRejectedError, flushOutbox, setInPlan } from './itinerary';

// Page-side wiring for the plan: hooks for screens, and getting queued edits to the server.

const PlanContext = createContext<Map<string, ItineraryItem>>(new Map());

/** One live query for the whole app, rather than one per row that shows a star. */
export function PlanProvider({ children }: { children: ReactNode }) {
  const items = useLiveQuery(() => db.itinerary.where('state').equals('added').toArray(), [], []);
  const plan = useMemo(() => new Map(items.map((i) => [i.sessionId, i])), [items]);
  return <PlanContext.Provider value={plan}>{children}</PlanContext.Provider>;
}

/** Sessions in the plan (tombstones excluded), by session id. */
export function usePlan(): Map<string, ItineraryItem> {
  return useContext(PlanContext);
}

/** Edits made on this device that haven't reached the server yet. */
export function usePendingCount(): number {
  return useLiveQuery(() => db.outbox.count(), [], 0);
}

/** Adds or removes a session, then tries to send the change right away. */
export async function togglePlan(sessionId: string, saved: boolean, title?: string) {
  await setInPlan(db, sessionId, saved, title);
  if (saved) void askToKeepData();
  registerBackgroundSync();
  void requestFlush();
}

/**
 * The plan only exists on this device until synced, and browsers may clear storage under pressure.
 * Ask to keep it once the attendee has something worth keeping (Chrome decides silently; Firefox
 * asks the user, which is fine right after they saved something).
 */
async function askToKeepData() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    // Not supported: nothing to do.
  }
}

/** Lets the service worker send queued edits even if the app is closed (Chromium only). */
function registerBackgroundSync() {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync?.register('outbox'))
    .catch(() => {});
}

// ---------- flushing with retry ----------

let outboxError: string | null = null;
const listeners = new Set<() => void>();
const setOutboxError = (message: string | null) => {
  outboxError = message;
  listeners.forEach((l) => l());
};

/** The last edit batch the server refused outright (they were dropped), if any. */
export function useOutboxError(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => outboxError,
  );
}

let flushing: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 5 * 60_000;
let retryMs = FIRST_RETRY_MS;

/** Sends queued edits now. On failure, retries with exponential backoff while online. */
export function requestFlush(): Promise<void> {
  clearTimeout(retryTimer);
  flushing ??= (async () => {
    try {
      await flushOutbox(db);
      retryMs = FIRST_RETRY_MS;
      setOutboxError(null);
    } catch (err) {
      if (err instanceof OutboxRejectedError) {
        setOutboxError(err.message);
      } else if (navigator.onLine) {
        retryTimer = setTimeout(() => void requestFlush(), retryMs);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      }
      // Offline: the 'online' event triggers the next attempt.
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}
