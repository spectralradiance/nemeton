import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Snapshot } from '@nemeton/shared';
import { createApp } from './app';
import { Store } from './store';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../data/seed/festival.json', import.meta.url), 'utf8')),
);

let store: Store;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  store = Store.open(':memory:', () => seed);
  app = createApp(store);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const report = (body: unknown, client = '203.0.113.7') =>
  app.request('/api/errors', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'TestPhone/1.0',
      'X-Forwarded-For': client,
    },
    body: JSON.stringify(body),
  });

describe('POST /api/errors', () => {
  it('stores a crash report for organizers to read', async () => {
    const res = await report({
      message: 'TypeError: x is undefined',
      stack: 'at Plan (Plan.tsx:10)',
      path: '/plan',
      version: '2026-10-12 09:00',
    });
    expect(res.status).toBe(204);
    const { token } = store.addOrganizer('Org');
    const list = await app.request('/api/admin/errors', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(((await list.json()) as { errors: unknown[] }).errors).toEqual([
      expect.objectContaining({
        message: 'TypeError: x is undefined',
        path: '/plan',
        version: '2026-10-12 09:00',
        userAgent: 'TestPhone/1.0',
      }),
    ]);
  });

  it('rejects reports without a message and truncates huge ones', async () => {
    expect((await report({ stack: 'x' })).status).toBe(400);
    await report({ message: 'x'.repeat(10_000), stack: 'y'.repeat(100_000) });
    const [stored] = store.clientErrors();
    expect(stored!.message).toHaveLength(500);
    expect(stored!.stack).toHaveLength(4000);
  });

  it('limits how often one client can report', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await report({ message: `e${i}` })).status);
    expect(statuses.filter((s) => s === 204)).toHaveLength(10);
    expect(statuses.at(-1)).toBe(429);
    expect((await report({ message: 'other client' }, '198.51.100.1')).status).toBe(204);
  });

  it('keeps only the most recent 1000 reports', () => {
    for (let i = 0; i < 1005; i++) {
      store.recordClientError({
        message: `e${i}`,
        stack: null,
        path: null,
        version: null,
        userAgent: null,
      });
    }
    const recent = store.clientErrors(2000);
    expect(recent).toHaveLength(1000);
    expect(recent[0]!.message).toBe('e1004');
  });

  it('only shows reports to organizers', async () => {
    expect((await app.request('/api/admin/errors')).status).toBe(401);
  });
});
