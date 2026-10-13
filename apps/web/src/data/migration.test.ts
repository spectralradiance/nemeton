import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { Snapshot, tickHlc } from '@nemeton/shared';
import { createApp } from '@nemeton/server/app';
import { Store } from '@nemeton/server/store';
import { DATA_VERSION, NemetonDB, readSnapshot } from './db';
import { flushOutbox } from './itinerary';
import { syncSchedule } from './sync';

// Installs made by older app versions must keep working after an update: server-owned data may be
// re-downloaded, but the attendee's own plan and unsent edits must survive every upgrade.

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const serve = (s: Store): typeof fetch => {
  const app = createApp(s);
  return async (input, init) => app.request(String(input), init);
};

let n = 0;
const names: string[] = [];
const freshName = () => {
  const name = `migrate-${n++}`;
  names.push(name);
  return name;
};
afterEach(async () => {
  await Promise.all(names.splice(0).map((name) => Dexie.delete(name)));
});

describe('IndexedDB upgrades', () => {
  it('a Phase 2 install (schema v1, data v1) re-downloads its schedule after updating', async () => {
    const name = freshName();
    const old = new Dexie(name);
    old.version(1).stores({
      festival: 'key',
      stages: 'id',
      sessions: 'id, day, stageId',
      vendors: 'id',
      meta: 'key',
    });
    await old.table('festival').put({ ...seed.festival, key: 'festival' });
    await old.table('sessions').bulkPut(seed.sessions);
    await old.table('meta').put({ key: 'sync', dataVersion: 1, seq: 0, etag: '"x"', syncedAt: 1 });
    old.close();

    const db = new NemetonDB(name);
    expect(await readSnapshot(db)).toBeNull(); // old data shape: not trusted
    for (const table of ['feed', 'itinerary', 'outbox', 'device'] as const) {
      expect(await db[table].count()).toBe(0);
    }
    const store = Store.open(':memory:', () => seed);
    expect(await syncSchedule(db, serve(store))).toBe('updated');
    expect((await db.meta.get('sync'))?.dataVersion).toBe(DATA_VERSION);
    expect((await readSnapshot(db))?.sessions).toHaveLength(seed.sessions.length);
    db.close();
  });

  it('a Phase 5 install (schema v3) keeps its plan and unsent edits, and they still sync', async () => {
    const name = freshName();
    const old = new Dexie(name);
    old.version(1).stores({
      festival: 'key',
      stages: 'id',
      sessions: 'id, day, stageId',
      vendors: 'id',
      meta: 'key',
    });
    old.version(2).stores({ feed: 'seq' });
    old.version(3).stores({
      itinerary: 'sessionId, state',
      outbox: 'opId, createdAt',
      device: 'key',
    });
    const deviceId = crypto.randomUUID();
    const h1 = tickHlc(null, deviceId);
    const h2 = tickHlc(h1, deviceId);
    await old.table('device').put({ key: 'device', deviceId, hlc: h2 });
    await old.table('itinerary').bulkPut([
      { sessionId: 'hail-fri', state: 'added', hlc: h1, updatedAt: 1, title: 'Hail' },
      { sessionId: 'fauna-sun', state: 'added', hlc: h2, updatedAt: 2, title: 'Fauna' },
    ]);
    // Same createdAt: the order v3 couldn't guarantee.
    await old.table('outbox').bulkPut([
      { opId: crypto.randomUUID(), sessionId: 'fauna-sun', state: 'added', hlc: h2, createdAt: 5, attempts: 2 },
      { opId: crypto.randomUUID(), sessionId: 'hail-fri', state: 'added', hlc: h1, createdAt: 5, attempts: 0 },
    ]);
    old.close();

    const db = new NemetonDB(name);
    expect(db.verno).toBe(4);
    expect((await db.itinerary.toArray()).map((i) => i.sessionId).sort()).toEqual([
      'fauna-sun',
      'hail-fri',
    ]);
    expect((await db.outbox.orderBy('hlc').toArray()).map((o) => o.sessionId)).toEqual([
      'hail-fri',
      'fauna-sun',
    ]);

    const store = Store.open(':memory:', () => seed);
    expect(await flushOutbox(db, serve(store))).toEqual({ sent: 2 });
    const { userId } = (await db.device.get('device'))!;
    expect(store.itinerary(userId!)).toEqual(['fauna-sun', 'hail-fri']);
    db.close();
  });
});
