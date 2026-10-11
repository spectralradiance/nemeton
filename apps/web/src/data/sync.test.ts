import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Snapshot, type ChangeInput } from '@nemeton/shared';
import { createApp } from '@nemeton/server/app';
import { Store } from '@nemeton/server/store';
import { DATA_VERSION, NemetonDB, readSnapshot, writeSnapshot } from './db';
import { syncSchedule } from './sync';

// Client sync runs against the real server app (in-memory SQLite), so both sides of the
// change-log protocol are tested together.

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const hail = seed.sessions.find((s) => s.id === 'hail-fri')!;

let db: NemetonDB;
let store: Store;
let requests: string[];
let n = 0;

function serve(s: Store): typeof fetch {
  const app = createApp(s);
  return async (input, init) => {
    const url = String(input);
    requests.push(url.replace(/\?.*/, ''));
    return app.request(url, init);
  };
}
let fetchImpl: typeof fetch;

beforeEach(() => {
  db = new NemetonDB(`test-${n++}`);
  store = Store.open(':memory:', () => seed);
  requests = [];
  fetchImpl = serve(store);
});
afterEach(async () => {
  await db.delete();
});

const publish = (...changes: ChangeInput[]) => store.apply(changes, 'Test');
const stored = async (id: string) => (await readSnapshot(db))?.sessions.find((s) => s.id === id);

describe('IndexedDB storage', () => {
  it('round-trips a snapshot', async () => {
    await writeSnapshot(db, seed, 'e1');
    const snap = await readSnapshot(db);
    expect(snap?.sessions).toHaveLength(seed.sessions.length);
    expect(snap?.festival).toEqual(seed.festival);
    expect(snap?.stages.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('treats data from an older app version as missing', async () => {
    await writeSnapshot(db, seed, 'e1');
    await db.meta.update('sync', { dataVersion: DATA_VERSION - 1 });
    expect(await readSnapshot(db)).toBeNull();
  });
});

describe('syncSchedule', () => {
  it('downloads the full schedule the first time', async () => {
    expect(await syncSchedule(db, fetchImpl)).toBe('updated');
    expect(requests).toEqual(['/api/schedule/snapshot']);
    expect((await readSnapshot(db))?.sessions).toHaveLength(seed.sessions.length);
    expect(await db.meta.get('sync')).toMatchObject({ seq: 0, epoch: store.epoch });
  });

  it('afterwards fetches only the changes', async () => {
    await syncSchedule(db, fetchImpl);
    publish({ op: 'upsert', entity: 'session', id: hail.id, data: { ...hail, status: 'delayed' } });
    publish({ op: 'delete', entity: 'session', id: 'gethen-fri' });
    requests = [];

    expect(await syncSchedule(db, fetchImpl)).toBe('updated');
    expect(requests).toEqual(['/api/schedule/changes']);
    expect((await stored(hail.id))?.status).toBe('delayed');
    expect(await stored('gethen-fri')).toBeUndefined();
    expect((await db.meta.get('sync'))?.seq).toBe(2);
  });

  it('reports unchanged, and records the check, when nothing changed', async () => {
    await syncSchedule(db, fetchImpl);
    await db.meta.update('sync', { syncedAt: 0 });
    expect(await syncSchedule(db, fetchImpl)).toBe('unchanged');
    expect((await db.meta.get('sync'))!.syncedAt).toBeGreaterThan(0);
  });

  it('starts over from a full download when the server database was reset', async () => {
    await syncSchedule(db, fetchImpl);
    const reset = Store.open(':memory:', () => ({
      ...seed,
      festival: { ...seed.festival, name: 'After reset' },
    }));
    requests = [];
    expect(await syncSchedule(db, serve(reset))).toBe('updated');
    expect(requests).toEqual(['/api/schedule/changes', '/api/schedule/snapshot']);
    expect((await readSnapshot(db))?.festival.name).toBe('After reset');
    expect((await db.meta.get('sync'))?.epoch).toBe(reset.epoch);
  });

  it('starts over when a batch does not line up with what is stored', async () => {
    await syncSchedule(db, fetchImpl);
    publish({ op: 'delete', entity: 'vendor', id: 'corviid' });
    // A batch claiming to start at seq 5 when we're at 0: a gap we can't trust.
    const gappy: typeof fetch = async (input, init) => {
      const res = await fetchImpl(input, init);
      if (!String(input).includes('/changes')) return res;
      return Response.json({ ...(await res.json()), from: 5 });
    };
    expect(await syncSchedule(db, gappy)).toBe('updated');
    expect(requests.at(-1)).toBe('/api/schedule/snapshot');
    expect((await readSnapshot(db))?.vendors.some((v) => v.id === 'corviid')).toBe(false);
  });

  it('rolls back the whole batch if any change is unreadable', async () => {
    await syncSchedule(db, fetchImpl);
    publish({ op: 'upsert', entity: 'session', id: hail.id, data: { ...hail, status: 'delayed' } });
    publish({ op: 'delete', entity: 'vendor', id: 'corviid' });
    const corrupt: typeof fetch = async (input, init) => {
      const res = await fetchImpl(input, init);
      if (!String(input).includes('/changes')) return res;
      const body = await res.json();
      body.changes[1] = { ...body.changes[1], op: 'upsert', data: { id: 'corviid' } };
      return Response.json(body);
    };
    await expect(syncSchedule(db, corrupt)).rejects.toThrow();
    expect((await stored(hail.id))?.status).toBe('scheduled');
    expect((await db.meta.get('sync'))?.seq).toBe(0);
  });

  it('reports server errors', async () => {
    const down: typeof fetch = async () => new Response(null, { status: 503 });
    await expect(syncSchedule(db, down)).rejects.toThrow('503');
  });
});
