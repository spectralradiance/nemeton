import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Snapshot } from '@nemeton/shared';
import { DATA_VERSION, NemetonDB, readSnapshot, writeSnapshot } from './db';
import { syncSnapshot } from './sync';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../../data/seed/festival.json', import.meta.url), 'utf8')),
);

let db: NemetonDB;
let n = 0;
beforeEach(() => {
  db = new NemetonDB(`test-${n++}`);
});
afterEach(async () => {
  await db.delete();
});

function respond(status: number, body?: unknown, etag?: string) {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: etag ? { etag } : {},
      }),
  );
}

describe('IndexedDB storage', () => {
  it('round-trips a snapshot', async () => {
    await writeSnapshot(db, seed, '"v1"');
    const stored = await readSnapshot(db);
    expect(stored?.sessions).toHaveLength(seed.sessions.length);
    expect(stored?.festival).toEqual(seed.festival);
    expect(stored?.stages.map((s) => s.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it('treats data from an older app version as missing', async () => {
    await writeSnapshot(db, seed, null);
    await db.meta.update('sync', { dataVersion: DATA_VERSION - 1 });
    expect(await readSnapshot(db)).toBeNull();
  });

  it('replaces rather than merges, so removed sessions disappear', async () => {
    await writeSnapshot(db, seed, null);
    const fewer = { ...seed, seq: 1, sessions: seed.sessions.slice(0, 3) };
    await writeSnapshot(db, fewer, null);
    expect((await readSnapshot(db))?.sessions).toHaveLength(3);
  });
});

describe('syncSnapshot', () => {
  it('downloads and stores the schedule on first run', async () => {
    const fetch = respond(200, seed, '"v1"');
    expect(await syncSnapshot(db, fetch)).toBe('updated');
    expect((await readSnapshot(db))?.sessions).toHaveLength(seed.sessions.length);
    expect((await db.meta.get('sync'))?.etag).toBe('"v1"');
  });

  it('sends the stored ETag and keeps the data on 304', async () => {
    await writeSnapshot(db, seed, '"v1"');
    await db.meta.update('sync', { syncedAt: 0 });
    const fetch = respond(304);
    expect(await syncSnapshot(db, fetch)).toBe('unchanged');
    const init = fetch.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get('If-None-Match')).toBe('"v1"');
    expect((await db.meta.get('sync'))!.syncedAt).toBeGreaterThan(0);
    expect(await readSnapshot(db)).not.toBeNull();
  });

  it('ignores a response older than what is stored', async () => {
    await writeSnapshot(db, { ...seed, seq: 5 }, '"v5"');
    expect(await syncSnapshot(db, respond(200, { ...seed, seq: 4 }, '"v4"'))).toBe('unchanged');
    expect((await readSnapshot(db))?.seq).toBe(5);
  });

  it('rejects invalid data without touching what is stored', async () => {
    await writeSnapshot(db, seed, '"v1"');
    await expect(syncSnapshot(db, respond(200, { nope: true }))).rejects.toThrow();
    expect((await readSnapshot(db))?.sessions).toHaveLength(seed.sessions.length);
  });

  it('reports server errors', async () => {
    await expect(syncSnapshot(db, respond(503))).rejects.toThrow('503');
  });
});
