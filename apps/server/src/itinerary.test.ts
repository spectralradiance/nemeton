import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { DeviceRegistration, Snapshot, tickHlc, type ItineraryOp } from '@nemeton/shared';
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
});

async function register(deviceId = crypto.randomUUID()) {
  const res = await app.request('/api/devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  expect(res.status).toBe(201);
  return DeviceRegistration.parse(await res.json());
}

function sendOps(token: string, ops: ItineraryOp[]) {
  return app.request('/api/itinerary/ops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ops }),
  });
}

/** Ops stamped in order by one device, as the client would make them. */
function opsFor(deviceId: string, ...steps: Array<[string, 'added' | 'removed']>) {
  let hlc: string | null = null;
  return steps.map(([sessionId, state]) => {
    hlc = tickHlc(hlc, deviceId);
    return { opId: crypto.randomUUID(), sessionId, state, hlc };
  });
}

describe('itinerary sync', () => {
  it('ends at the latest state after add, remove, add made offline', async () => {
    const dev = await register();
    const ops = opsFor(
      dev.deviceId,
      ['hail-fri', 'added'],
      ['hail-fri', 'removed'],
      ['hail-fri', 'added'],
    );
    // Even if the batch arrives shuffled, HLC order decides.
    const res = await sendOps(dev.token, [ops[2]!, ops[0]!, ops[1]!]);
    expect(await res.json()).toEqual({ applied: 3, duplicates: 0 });
    expect(store.itinerary(dev.userId)).toEqual(['hail-fri']);
  });

  it('applies an op retried three times only once', async () => {
    const dev = await register();
    const [add] = opsFor(dev.deviceId, ['fauna-sun', 'added']);
    for (let i = 0; i < 3; i++) await sendOps(dev.token, [add!]);
    const last = await sendOps(dev.token, [add!]);
    expect(await last.json()).toEqual({ applied: 0, duplicates: 1 });
    expect(store.popularity()).toEqual([{ sessionId: 'fauna-sun', count: 1 }]);
  });

  it('never lets an older op that arrives late undo a newer one', async () => {
    const dev = await register();
    const [add, remove] = opsFor(dev.deviceId, ['hail-fri', 'added'], ['hail-fri', 'removed']);
    await sendOps(dev.token, [remove!]);
    await sendOps(dev.token, [add!]); // older, arrives second
    expect(store.itinerary(dev.userId)).toEqual([]);
  });

  it('keeps each attendee separate and counts popularity across them', async () => {
    const a = await register();
    const b = await register();
    await sendOps(a.token, opsFor(a.deviceId, ['hail-fri', 'added'], ['fauna-sun', 'added']));
    await sendOps(b.token, opsFor(b.deviceId, ['hail-fri', 'added']));
    expect(store.itinerary(a.userId)).toEqual(['fauna-sun', 'hail-fri']);
    expect(store.itinerary(b.userId)).toEqual(['hail-fri']);
    expect(store.popularity()).toEqual([
      { sessionId: 'hail-fri', count: 2 },
      { sessionId: 'fauna-sun', count: 1 },
    ]);
  });

  it('accepts sessions that no longer exist, since it records what the attendee did', async () => {
    const dev = await register();
    const res = await sendOps(dev.token, opsFor(dev.deviceId, ['deleted-session', 'added']));
    expect(res.status).toBe(200);
  });
});

describe('device tokens', () => {
  it('rejects missing, malformed and forged tokens', async () => {
    const dev = await register();
    const ops = opsFor(dev.deviceId, ['hail-fri', 'added']);
    expect((await sendOps('', ops)).status).toBe(401);
    expect((await sendOps('dev_nonsense', ops)).status).toBe(401);
    const [payload] = dev.token.slice(4).split('.');
    const forged = `dev_${payload}.${'A'.repeat(43)}`;
    expect((await sendOps(forged, ops)).status).toBe(401);
  });

  it('stops working when the database is reset (new signing key)', async () => {
    const dev = await register();
    const other = createApp(Store.open(':memory:', () => seed));
    const res = await other.request('/api/itinerary/ops', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dev.token}` },
      body: JSON.stringify({ ops: opsFor(dev.deviceId, ['hail-fri', 'added']) }),
    });
    expect(res.status).toBe(401);
  });

  it('validates registration and op payloads', async () => {
    const bad = await app.request('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'x' }),
    });
    expect(bad.status).toBe(422);
    const dev = await register();
    const res = await sendOps(dev.token, [{ opId: 'not-a-uuid' } as unknown as ItineraryOp]);
    expect(res.status).toBe(422);
  });
});

describe('GET /api/admin/stats', () => {
  it('lists sessions by how many attendees saved them, for organizers only', async () => {
    const dev = await register();
    await sendOps(dev.token, opsFor(dev.deviceId, ['hail-fri', 'added']));
    expect((await app.request('/api/admin/stats')).status).toBe(401);
    const { token } = store.addOrganizer('Org');
    const res = await app.request('/api/admin/stats', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(await res.json()).toEqual({
      sessions: [{ sessionId: 'hail-fri', count: 1, title: 'Hail' }],
    });
  });
});
