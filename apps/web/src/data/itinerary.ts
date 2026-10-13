import { DeviceRegistration, tickHlc } from '@nemeton/shared';
import type { DeviceRow, NemetonDB, OutboxOp } from './db';

// The attendee's plan, stored on the device first. Every edit is applied locally and queued in the
// outbox in one transaction, so it works offline and survives restarts. The outbox is flushed to the
// server by the page (on start, reconnect, return to the app, after edits) and, where supported, by
// the service worker's Background Sync even after the app is closed.
//
// No DOM or React here: the service worker imports this module too.

/** Saves or removes a session from the plan, and queues the change for the server. */
export async function setInPlan(
  database: NemetonDB,
  sessionId: string,
  saved: boolean,
  /** Kept so the plan can still name a session the organizers later remove. */
  title?: string,
) {
  await database.transaction('rw', [database.itinerary, database.outbox, database.device], async () => {
    const device = await getDevice(database);
    const hlc = tickHlc(device.hlc, device.deviceId);
    const state = saved ? 'added' : 'removed';
    const now = Date.now();
    // Removals stay as tombstones, so an older "added" from anywhere can never bring them back.
    const previous = await database.itinerary.get(sessionId);
    await database.itinerary.put({
      sessionId,
      state,
      hlc,
      updatedAt: now,
      title: title ?? previous?.title,
    });
    await database.outbox.put({
      opId: crypto.randomUUID(),
      sessionId,
      state,
      hlc,
      createdAt: now,
      attempts: 0,
    });
    await database.device.update('device', { hlc });
  });
}

async function getDevice(database: NemetonDB): Promise<DeviceRow> {
  const existing = await database.device.get('device');
  if (existing) return existing;
  const fresh: DeviceRow = { key: 'device', deviceId: crypto.randomUUID(), hlc: null };
  await database.device.put(fresh);
  return fresh;
}

/** The server rejected the ops themselves (4xx). They were dropped so they don't block the queue. */
export class OutboxRejectedError extends Error {}

const BATCH = 500;

/**
 * Sends queued edits to the server, oldest first, and removes them once confirmed. Safe to run
 * from several places at once: the server ignores op ids it has already applied.
 * Throws on network or server errors so callers (and Background Sync) know to retry.
 */
export async function flushOutbox(
  database: NemetonDB,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number }> {
  let sent = 0;
  let reRegistered = false;
  for (;;) {
    const ops = await database.outbox.orderBy('hlc').limit(BATCH).toArray();
    if (ops.length === 0) return { sent };

    const device = await register(database, fetchImpl);
    const res = await post(fetchImpl, device.token!, ops);

    if (res.status === 401 && !reRegistered) {
      // The server doesn't know this device (e.g. its data was reset). Register again and resend
      // the whole plan, so the server's copy is complete again.
      reRegistered = true;
      await database.device.update('device', { userId: undefined, token: undefined });
      await requeueWholePlan(database);
      continue;
    }
    if (res.ok) {
      await database.outbox.bulkDelete(ops.map((o) => o.opId));
      sent += ops.length;
      continue;
    }
    if (res.status >= 400 && res.status < 500) {
      await database.outbox.bulkDelete(ops.map((o) => o.opId));
      throw new OutboxRejectedError(`The server refused ${ops.length} change(s) (${res.status})`);
    }
    await bumpAttempts(database, ops);
    throw new Error(`The server answered ${res.status}`);
  }
}

async function register(database: NemetonDB, fetchImpl: typeof fetch): Promise<DeviceRow> {
  const device = await getDevice(database);
  if (device.token) return device;
  const res = await fetchImpl('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: device.deviceId }),
  });
  if (!res.ok) throw new Error(`Couldn't register this device (${res.status})`);
  const { userId, token } = DeviceRegistration.parse(await res.json());
  await database.device.update('device', { userId, token });
  return { ...device, userId, token };
}

function post(fetchImpl: typeof fetch, token: string, ops: OutboxOp[]) {
  return fetchImpl('/api/itinerary/ops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ops: ops.map(({ opId, sessionId, state, hlc }) => ({ opId, sessionId, state, hlc })),
    }),
  });
}

async function bumpAttempts(database: NemetonDB, ops: OutboxOp[]) {
  await database.outbox.bulkPut(ops.map((o) => ({ ...o, attempts: o.attempts + 1 })));
}

/** Replaces the queue with one op per item in the plan (including tombstones). */
async function requeueWholePlan(database: NemetonDB) {
  await database.transaction('rw', [database.itinerary, database.outbox], async () => {
    const items = await database.itinerary.toArray();
    await database.outbox.clear();
    const now = Date.now();
    await database.outbox.bulkPut(
      items.map((item, i) => ({
        opId: crypto.randomUUID(),
        sessionId: item.sessionId,
        state: item.state,
        hlc: item.hlc,
        createdAt: now + i,
        attempts: 0,
      })),
    );
  });
}
