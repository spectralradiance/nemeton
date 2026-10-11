import { Hono } from 'hono';
import type { ChangesResponse, SnapshotResponse } from '@nemeton/shared';
import { StoreError, type Organizer, type Store } from './store';

type Env = { Variables: { organizer: Organizer } };

export function createApp(store: Store) {
  const app = new Hono<Env>().basePath('/api');

  app.get('/health', (c) => c.json({ ok: true, epoch: store.epoch, seq: store.seq }));

  // ---------- public: schedule ----------

  app.get('/schedule/snapshot', (c) => {
    const etag = `"${store.epoch}:${store.seq}"`;
    c.header('ETag', etag);
    // Clients must revalidate so a changed schedule is never served stale from the HTTP cache.
    c.header('Cache-Control', 'no-cache');
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304);
    const body: SnapshotResponse = { ...store.snapshot(), epoch: store.epoch };
    return c.json(body);
  });

  app.get('/schedule/changes', (c) => {
    c.header('Cache-Control', 'no-store');
    const since = Number(c.req.query('since'));
    if (!Number.isInteger(since) || since < 0) {
      return c.json({ error: '`since` must be a non-negative integer' }, 400);
    }
    // 410 Gone: the client must start over from a full snapshot.
    const epoch = c.req.query('epoch');
    if (epoch !== undefined && epoch !== store.epoch) {
      return c.json({ error: 'The schedule was reset; download it again.' }, 410);
    }
    const changes = store.changesSince(since);
    if (!changes) return c.json({ error: 'Too far behind; download the schedule again.' }, 410);
    const body: ChangesResponse = { epoch: store.epoch, from: since, to: store.seq, changes };
    return c.json(body);
  });

  // ---------- organizers ----------

  app.use('/admin/*', async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
    const organizer = token ? store.authenticate(token) : null;
    if (!organizer) return c.json({ error: 'Missing or invalid organizer token' }, 401);
    c.set('organizer', organizer);
    await next();
  });

  app.get('/admin/whoami', (c) => c.json(c.get('organizer')));

  app.post('/admin/changes', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      changes?: unknown;
      baseSeq?: unknown;
    } | null;
    if (!body || !Array.isArray(body.changes)) {
      return c.json({ error: 'Expected { changes: [...], baseSeq?: number }' }, 400);
    }
    if (body.baseSeq !== undefined && !Number.isInteger(body.baseSeq)) {
      return c.json({ error: '`baseSeq` must be an integer' }, 400);
    }
    const { name } = c.get('organizer');
    const result = store.apply(body.changes, name, body.baseSeq as number | undefined);
    return c.json({ from: result.from, to: result.to, count: result.changes.length });
  });

  app.get('/admin/log', (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 500);
    return c.json({ changes: store.log(limit) });
  });

  app.onError((err, c) => {
    if (err instanceof StoreError) {
      return c.json({ error: err.message, details: err.details }, err.status);
    }
    console.error(err);
    return c.json({ error: 'Internal error' }, 500);
  });

  return app;
}
