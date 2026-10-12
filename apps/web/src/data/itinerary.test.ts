import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Snapshot } from '@nemeton/shared';
import { createApp } from '@nemeton/server/app';
import { Store } from '@nemeton/server/store';
import { NemetonDB } from './db';
import { OutboxRejectedError, flushOutbox, setInPlan } from './itinerary';

// The plan's outbox against the real server app (in-memory SQLite).

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../../data/seed/festival.json', import.meta.url), 'utf8')),
);

let db: NemetonDB;
let store: Store;
let n = 0;
const serve = (s: Store): typeof fetch => {
  const app = createApp(s);
  return async (input, init) => app.request(String(input), init);
};
let online: typeof fetch;
const offline: typeof fetch = async () => {
  throw new TypeError('Failed to fetch');
};

beforeEach(() => {
  db = new NemetonDB(`plan-${n++}`);
  store = Store.open(':memory:', () => seed);
  online = serve(store);
});
afterEach(async () => {
  await db.delete();
});

const serverPlan = async () => store.itinerary((await db.device.get('device'))!.userId!);

describe('plan edits offline', () => {
  it('apply locally at once and queue for the server', async () => {
    await setInPlan(db, 'hail-fri', true, 'Hail');
    expect(await db.itinerary.get('hail-fri')).toMatchObject({ state: 'added', title: 'Hail' });
    expect(await db.outbox.count()).toBe(1);
    await expect(flushOutbox(db, offline)).rejects.toThrow();
    expect(await db.outbox.count()).toBe(1); // still queued
  });

  it('add, remove, add while offline ends at "added" on the server, sent in order', async () => {
    await setInPlan(db, 'hail-fri', true);
    await setInPlan(db, 'hail-fri', false);
    await setInPlan(db, 'hail-fri', true);
    const hlcs = (await db.outbox.orderBy('createdAt').toArray()).map((o) => o.hlc);
    expect([...hlcs].sort()).toEqual(hlcs);

    expect(await flushOutbox(db, online)).toEqual({ sent: 3 });
    expect(await serverPlan()).toEqual(['hail-fri']);
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps removals as tombstones locally', async () => {
    await setInPlan(db, 'hail-fri', true);
    await setInPlan(db, 'hail-fri', false);
    expect(await db.itinerary.get('hail-fri')).toMatchObject({ state: 'removed' });
  });

  it('never reuses a clock value, even across many quick edits', async () => {
    for (let i = 0; i < 20; i++) await setInPlan(db, `s${i}`, true);
    const hlcs = (await db.outbox.toArray()).map((o) => o.hlc);
    expect(new Set(hlcs).size).toBe(20);
    expect((await db.device.get('device'))!.hlc).toBe([...hlcs].sort().at(-1));
  });
});

describe('flushOutbox', () => {
  it('applies a retried batch once when the first response was lost', async () => {
    await setInPlan(db, 'fauna-sun', true);
    // The server gets the request, but the response never arrives.
    const lostResponse: typeof fetch = async (input, init) => {
      const res = await online(input, init);
      if (String(input).includes('/itinerary/ops')) throw new TypeError('connection reset');
      return res;
    };
    await expect(flushOutbox(db, lostResponse)).rejects.toThrow();
    expect((await db.outbox.toArray())[0]!.attempts).toBe(0); // network error, not a server error
    expect(await flushOutbox(db, online)).toEqual({ sent: 1 });
    expect(store.popularity()).toEqual([{ sessionId: 'fauna-sun', count: 1 }]);
  });

  it('counts failed attempts on server errors', async () => {
    await setInPlan(db, 'fauna-sun', true);
    await flushOutbox(db, online); // registers the device
    await setInPlan(db, 'hail-fri', true);
    const down: typeof fetch = async () => new Response(null, { status: 503 });
    await expect(flushOutbox(db, down)).rejects.toThrow('503');
    expect((await db.outbox.toArray())[0]!.attempts).toBe(1);
  });

  it('re-registers and resends the whole plan after a server reset', async () => {
    await setInPlan(db, 'hail-fri', true);
    await setInPlan(db, 'fauna-sun', true);
    await setInPlan(db, 'fauna-sun', false);
    await flushOutbox(db, online);
    const oldUser = (await db.device.get('device'))!.userId;

    const reset = Store.open(':memory:', () => seed);
    await setInPlan(db, 'gethen-fri', true);
    await flushOutbox(db, serve(reset));

    const device = (await db.device.get('device'))!;
    expect(device.userId).not.toBe(oldUser);
    expect(reset.itinerary(device.userId!)).toEqual(['gethen-fri', 'hail-fri']);
    expect(await db.outbox.count()).toBe(0);
  });

  it('drops edits the server refuses outright, so they do not block the queue', async () => {
    await setInPlan(db, 'hail-fri', true);
    await flushOutbox(db, online);
    await db.outbox.put({
      opId: 'not-a-uuid',
      sessionId: 'x',
      state: 'added',
      hlc: 'bad',
      createdAt: Date.now(),
      attempts: 0,
    });
    await expect(flushOutbox(db, online)).rejects.toThrow(OutboxRejectedError);
    expect(await db.outbox.count()).toBe(0);
  });

  it('does nothing (and registers nothing) with an empty queue', async () => {
    expect(await flushOutbox(db, offline)).toEqual({ sent: 0 });
    expect(await db.device.get('device')).toBeUndefined();
  });
});
