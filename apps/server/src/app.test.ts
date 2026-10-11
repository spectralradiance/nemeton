import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChangesResponse, Snapshot, SnapshotResponse } from '@nemeton/shared';
import { createApp } from './app';
import { Store } from './store';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const hail = seed.sessions.find((s) => s.id === 'hail-fri')!;

let store: Store;
let app: ReturnType<typeof createApp>;
let token: string;

beforeEach(() => {
  store = Store.open(':memory:', () => seed);
  app = createApp(store);
  token = store.addOrganizer('Test Organizer').token;
});

const post = (body: unknown, auth = token) =>
  app.request('/api/admin/changes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
const delayHail = {
  op: 'upsert',
  entity: 'session',
  id: hail.id,
  data: { ...hail, status: 'delayed' },
};

describe('GET /api/schedule/snapshot', () => {
  it('returns the schedule with its epoch and seq', async () => {
    const res = await app.request('/api/schedule/snapshot');
    const body = SnapshotResponse.parse(await res.json());
    expect(body).toMatchObject({ seq: 0, epoch: store.epoch });
    expect(body.sessions).toHaveLength(seed.sessions.length);
  });

  it('answers 304 while nothing has changed, and 200 after a change', async () => {
    const etag = (await app.request('/api/schedule/snapshot')).headers.get('etag')!;
    const again = () =>
      app.request('/api/schedule/snapshot', { headers: { 'If-None-Match': etag } });
    expect((await again()).status).toBe(304);
    await post({ changes: [delayHail] });
    expect((await again()).status).toBe(200);
  });
});

describe('GET /api/schedule/changes', () => {
  it('returns changes after `since`, in order, with their author', async () => {
    await post({ changes: [delayHail] });
    await post({ changes: [{ op: 'delete', entity: 'vendor', id: 'corviid' }] });
    const res = await app.request(`/api/schedule/changes?since=1&epoch=${store.epoch}`);
    const body = ChangesResponse.parse(await res.json());
    expect(body).toMatchObject({ from: 1, to: 2 });
    expect(body.changes).toEqual([
      expect.objectContaining({ seq: 2, op: 'delete', entity: 'vendor', author: 'Test Organizer' }),
    ]);
  });

  it('answers 410 when the client is from another epoch or ahead of the server', async () => {
    expect((await app.request('/api/schedule/changes?since=0&epoch=other')).status).toBe(410);
    expect((await app.request('/api/schedule/changes?since=99')).status).toBe(410);
  });

  it('rejects a bad `since`', async () => {
    expect((await app.request('/api/schedule/changes?since=-1')).status).toBe(400);
    expect((await app.request('/api/schedule/changes')).status).toBe(400);
  });
});

describe('POST /api/admin/changes', () => {
  it('requires a valid, unrevoked organizer token', async () => {
    expect((await post({ changes: [delayHail] }, 'nope')).status).toBe(401);
    const [org] = store.listOrganizers();
    store.revokeOrganizer(org!.id);
    expect((await post({ changes: [delayHail] })).status).toBe(401);
  });

  it('applies changes and bumps seq', async () => {
    const res = await post({ changes: [delayHail], baseSeq: 0 });
    expect(await res.json()).toEqual({ from: 0, to: 1, count: 1 });
    expect(store.snapshot().sessions.find((s) => s.id === hail.id)?.status).toBe('delayed');
  });

  it('refuses with 409 when the schedule moved on since baseSeq', async () => {
    await post({ changes: [delayHail] });
    const res = await post({ changes: [delayHail], baseSeq: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ details: { seq: 1 } });
  });

  it('rejects the whole batch if any change would break the schedule', async () => {
    const res = await post({
      changes: [
        delayHail,
        { op: 'upsert', entity: 'session', id: hail.id, data: { ...hail, stageId: 'nowhere' } },
      ],
    });
    expect(res.status).toBe(422);
    expect(store.seq).toBe(0);
    expect(store.snapshot().sessions.find((s) => s.id === hail.id)?.status).toBe('scheduled');
  });

  it('rejects malformed requests', async () => {
    expect((await post({ nope: true })).status).toBe(400);
    expect((await post({ changes: [{ op: 'explode' }] })).status).toBe(422);
  });
});

describe('Store persistence', () => {
  it('keeps the same epoch and data when reopened', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'nemeton-'));
    try {
      const path = join(dir, 'test.db');
      const a = Store.open(path, () => seed);
      a.apply([delayHail], 'Someone');
      const epoch = a.epoch;
      a.close();
      const b = Store.open(path);
      expect(b.epoch).toBe(epoch);
      expect(b.seq).toBe(1);
      expect(b.log()[0]).toMatchObject({ author: 'Someone', id: hail.id });
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
