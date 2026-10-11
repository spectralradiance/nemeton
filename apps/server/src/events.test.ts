import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangesResponse, Snapshot } from '@nemeton/shared';
import { createApp } from './app';
import { ChangeHub } from './hub';
import { Store } from './store';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const hail = seed.sessions.find((s) => s.id === 'hail-fri')!;

let store: Store;
let hub: ChangeHub;
let app: ReturnType<typeof createApp>;
let token: string;
const open: Array<() => Promise<void>> = [];

beforeEach(() => {
  store = Store.open(':memory:', () => seed);
  hub = new ChangeHub();
  app = createApp(store, hub, 30);
  token = store.addOrganizer('Test').token;
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((close) => close()));
});

const publish = (status: 'delayed' | 'cancelled') =>
  app.request('/api/admin/changes', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changes: [{ op: 'upsert', entity: 'session', id: hail.id, data: { ...hail, status } }],
    }),
  });

interface SseEvent {
  event?: string;
  id?: string;
  data?: string;
  comment?: string;
}

/** Opens the event stream and returns a reader of parsed SSE blocks. */
async function connect(path: string, headers: Record<string, string> = {}) {
  const res = await app.request(path, { headers });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const close = () => reader.cancel().catch(() => {});
  open.push(close);

  async function next(timeoutMs = 2000): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const ev: SseEvent = {};
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) ev.comment = line.slice(1).trim();
          const m = /^(event|id|data): ?(.*)$/.exec(line);
          if (m) ev[m[1] as 'event' | 'id' | 'data'] = m[2];
        }
        return ev;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for an event');
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), remaining),
        ),
      ]);
      if (chunk.done) throw new Error('stream ended');
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  /** Next event that isn't a heartbeat. */
  async function nextEvent() {
    for (;;) {
      const ev = await next();
      if (!ev.comment) return ev;
    }
  }
  return { res, next, nextEvent, close };
}

describe('GET /api/events', () => {
  it('replays what the client missed, then pushes new changes as they are published', async () => {
    await publish('delayed');
    const stream = await connect(`/api/events?since=0&epoch=${store.epoch}`);
    expect(stream.res.headers.get('content-type')).toContain('text/event-stream');

    const replay = await stream.nextEvent();
    expect(replay).toMatchObject({ event: 'changes', id: '1' });
    expect(ChangesResponse.parse(JSON.parse(replay.data!))).toMatchObject({ from: 0, to: 1 });

    await publish('cancelled');
    const live = await stream.nextEvent();
    expect(live).toMatchObject({ event: 'changes', id: '2' });
    const batch = ChangesResponse.parse(JSON.parse(live.data!));
    expect(batch).toMatchObject({ from: 1, to: 2 });
    expect(batch.changes[0]).toMatchObject({ id: hail.id, author: 'Test' });
  });

  it('resumes from Last-Event-ID on reconnect, ignoring the original ?since', async () => {
    await publish('delayed');
    await publish('cancelled');
    const stream = await connect(`/api/events?since=0`, { 'Last-Event-ID': '1' });
    const replay = ChangesResponse.parse(JSON.parse((await stream.nextEvent()).data!));
    expect(replay).toMatchObject({ from: 1, to: 2 });
    expect(replay.changes.map((c) => c.seq)).toEqual([2]);
  });

  it('sends nothing to replay when the client is up to date', async () => {
    const stream = await connect(`/api/events?since=0`);
    expect((await stream.next()).comment).toBe('ping');
  });

  it('tells clients from another epoch, or ahead of the server, to start over', async () => {
    for (const path of ['/api/events?since=0&epoch=old', '/api/events?since=99']) {
      const stream = await connect(path);
      expect(await stream.nextEvent()).toMatchObject({ event: 'reset' });
    }
  });

  it('stops listening when the client goes away', async () => {
    const stream = await connect('/api/events?since=0');
    await stream.next(); // heartbeat: the stream is open and subscribed
    expect(hub.size).toBe(1);
    await stream.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(hub.size).toBe(0);
  });
});
