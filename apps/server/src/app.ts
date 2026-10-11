import { Hono } from 'hono';
import { etag } from 'hono/etag';
import type { Snapshot } from '@nemeton/shared';

export function createApp(snapshot: Snapshot) {
  const body = JSON.stringify(snapshot);

  return new Hono()
    .basePath('/api')
    .get('/health', (c) => c.json({ ok: true, seq: snapshot.seq }))
    .use('/schedule/*', etag())
    .get('/schedule/snapshot', (c) => {
      // Clients must revalidate so a changed schedule is never served stale from the HTTP cache.
      c.header('Cache-Control', 'no-cache');
      c.header('Content-Type', 'application/json; charset=utf-8');
      return c.body(body);
    });
}
