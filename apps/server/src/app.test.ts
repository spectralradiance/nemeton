import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Snapshot } from '@nemeton/shared';
import { createApp } from './app';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const app = createApp(seed);

describe('GET /api/schedule/snapshot', () => {
  it('returns the snapshot with an ETag', async () => {
    const res = await app.request('/api/schedule/snapshot');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    expect(Snapshot.parse(await res.json()).sessions).toHaveLength(seed.sessions.length);
  });

  it('answers 304 when the client already has it', async () => {
    const first = await app.request('/api/schedule/snapshot');
    const res = await app.request('/api/schedule/snapshot', {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    expect(res.status).toBe(304);
  });
});
