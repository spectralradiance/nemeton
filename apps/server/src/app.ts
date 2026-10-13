import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { ItineraryOpsRequest, type ChangesResponse, type SnapshotResponse } from '@nemeton/shared';
import { ChangeHub } from './hub';
import { StoreError, type Organizer, type Store } from './store';

type Env = { Variables: { organizer: Organizer } };

const HEARTBEAT_MS = 25_000;
const ERRORS_PER_MINUTE = 10;

export function createApp(store: Store, hub = new ChangeHub(), heartbeatMs = HEARTBEAT_MS) {
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

  // ---------- public: live updates (Server-Sent Events) ----------
  //
  // On connect, replays everything after the client's seq (Last-Event-ID on automatic reconnects,
  // ?since on the first connection), then pushes each batch as it's published. Event ids are the
  // batch's `to` seq, so a browser reconnecting after a dropped connection resumes exactly there.

  app.get('/events', (c) => {
    const lastId = c.req.header('Last-Event-ID') ?? c.req.query('since');
    const since = Number(lastId);
    const epoch = c.req.query('epoch');

    return streamSSE(c, async (stream) => {
      const send = (batch: ChangesResponse) =>
        stream.writeSSE({ event: 'changes', id: String(batch.to), data: JSON.stringify(batch) });

      // Buffer live batches until the replay has been sent, so nothing arrives out of order.
      const pending: ChangesResponse[] = [];
      let replayed = false;
      const unsubscribe = hub.subscribe((batch) => {
        if (replayed) void send(batch);
        else pending.push(batch);
      });
      stream.onAbort(unsubscribe);

      const missed =
        Number.isInteger(since) && since >= 0 && (epoch === undefined || epoch === store.epoch)
          ? store.changesSince(since)
          : null;
      if (!missed) {
        // Can't bridge the gap from here: the client should start over from a full download.
        await stream.writeSSE({ event: 'reset', data: JSON.stringify({ epoch: store.epoch }) });
        unsubscribe();
        return;
      }
      const to = missed.at(-1)?.seq ?? since;
      if (missed.length > 0) await send({ epoch: store.epoch, from: since, to, changes: missed });
      for (const batch of pending.filter((b) => b.to > to)) await send(batch);
      replayed = true;

      // Comments keep proxies and mobile networks from closing an idle connection.
      while (!stream.aborted) {
        await stream.sleep(heartbeatMs);
        if (!stream.aborted) await stream.write(': ping\n\n');
      }
    });
  });

  // ---------- attendees: anonymous identity and itinerary ----------

  app.post('/devices', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { deviceId?: unknown } | null;
    if (typeof body?.deviceId !== 'string') return c.json({ error: 'Expected { deviceId }' }, 400);
    return c.json(store.registerDevice(body.deviceId), 201);
  });

  app.post('/itinerary/ops', async (c) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
    const device = token ? store.verifyDevice(token) : null;
    if (!device) return c.json({ error: 'Unknown device; register again' }, 401);
    const parsed = ItineraryOpsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Malformed itinerary ops', details: parsed.error.issues }, 422);
    }
    return c.json(store.applyItineraryOps(device, parsed.data.ops));
  });

  // ---------- crash reports from attendees' apps ----------

  // A crash loop on many phones mustn't flood the database: a few reports per client per minute.
  const reportsByClient = new Map<string, { count: number; windowStart: number }>();
  app.post('/errors', async (c) => {
    const client = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
    const now = Date.now();
    const bucket = reportsByClient.get(client);
    if (!bucket || now - bucket.windowStart > 60_000) {
      reportsByClient.set(client, { count: 1, windowStart: now });
      if (reportsByClient.size > 10_000) reportsByClient.clear();
    } else if (++bucket.count > ERRORS_PER_MINUTE) {
      return c.body(null, 429);
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof body?.message !== 'string' || body.message.length === 0) {
      return c.json({ error: 'Expected { message }' }, 400);
    }
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : null);
    const report = {
      message: body.message.slice(0, 500),
      stack: text(body.stack, 4000),
      path: text(body.path, 200),
      version: text(body.version, 64),
      userAgent: text(c.req.header('User-Agent'), 300),
    };
    store.recordClientError(report);
    console.warn(JSON.stringify({ type: 'client-error', ...report, stack: undefined }));
    return c.body(null, 204);
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
    hub.publish({ epoch: store.epoch, ...result });
    return c.json({ from: result.from, to: result.to, count: result.changes.length });
  });

  app.get('/admin/stats', (c) => {
    const titles = new Map(store.snapshot().sessions.map((s) => [s.id, s.title]));
    return c.json({
      sessions: store.popularity().map((p) => ({ ...p, title: titles.get(p.sessionId) ?? null })),
    });
  });

  app.get('/admin/errors', (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 500);
    return c.json({ errors: store.clientErrors(limit) });
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
