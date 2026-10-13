/**
 * Load test for live updates: opens N event-stream connections to a fresh server, publishes
 * changes as an organizer, and measures how long each change takes to reach every connection.
 *
 *   npm run load:sse -- 5000            # connections (default 1000)
 *   npm run load:sse -- 5000 --rounds 5
 *
 * Runs its own server process on a throwaway database, so it never touches dev data.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Snapshot } from '@nemeton/shared';
import { Store } from '@nemeton/server/store';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { rounds: { type: 'string', default: '3' }, port: { type: 'string', default: '8899' } },
});
const N = Number(positionals[0] ?? 1000);
const ROUNDS = Number(values.rounds);
const PORT = Number(values.port);
const BASE = `http://127.0.0.1:${PORT}`;

const dir = mkdtempSync(join(tmpdir(), 'nemeton-load-'));
const dbPath = join(dir, 'load.db');
const seed = Snapshot.parse(JSON.parse(readFileSync('data/seed/festival.json', 'utf8')));

// Seed the database and create an organizer before the server starts.
const setup = Store.open(dbPath, () => seed);
const { token } = setup.addOrganizer('Load Test');
setup.close();

const server = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/index.ts'], {
  env: { ...process.env, API_PORT: String(PORT), NEMETON_DB: dbPath },
  stdio: ['ignore', 'ignore', 'inherit'],
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function health() {
  return (await (await fetch(`${BASE}/api/health`)).json()) as {
    streams: number;
    rssMb: number;
    seq: number;
  };
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      return await health();
    } catch {
      await sleep(100);
    }
  }
  throw new Error('server did not start');
}

const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });
/** seq -> arrival times (ms) across connections */
const arrivals = new Map<number, number[]>();
const sockets: http.ClientRequest[] = [];

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE}/api/events?since=0`, { agent }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.setEncoding('utf8');
      let buffer = '';
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: (\d+)$/m.exec(block)?.[1];
          if (id && block.includes('event: changes')) {
            const seq = Number(id);
            arrivals.set(seq, [...(arrivals.get(seq) ?? []), performance.now()]);
          }
        }
      });
      resolve();
    });
    req.on('error', reject);
    sockets.push(req);
  });
}

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

async function main() {
  const idle = await waitForServer();
  console.log(`Server up (rss ${idle.rssMb} MB). Opening ${N} connections…`);

  const t0 = performance.now();
  for (let i = 0; i < N; i += 200) {
    await Promise.all(Array.from({ length: Math.min(200, N - i) }, connect));
  }
  while ((await health()).streams < N) await sleep(50);
  const loaded = await health();
  console.log(
    `${N} connected in ${((performance.now() - t0) / 1000).toFixed(1)} s; server rss ${loaded.rssMb} MB ` +
      `(~${(((loaded.rssMb - idle.rssMb) * 1024) / N).toFixed(1)} KB per connection)`,
  );

  const hail = seed.sessions.find((s) => s.id === 'hail-fri')!;
  for (let round = 1; round <= ROUNDS; round++) {
    const sent = performance.now();
    const res = await fetch(`${BASE}/api/admin/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        changes: [
          {
            op: 'upsert',
            entity: 'session',
            id: hail.id,
            data: { ...hail, status: 'delayed', note: `Load test round ${round}` },
          },
        ],
      }),
    });
    const { to } = (await res.json()) as { to: number };
    const deadline = performance.now() + 30_000;
    while ((arrivals.get(to)?.length ?? 0) < N && performance.now() < deadline) await sleep(5);
    const got = arrivals.get(to) ?? [];
    const latencies = got.map((t) => t - sent).sort((a, b) => a - b);
    console.log(
      `Round ${round}: ${got.length}/${N} received · p50 ${pct(latencies, 50).toFixed(0)} ms · ` +
        `p95 ${pct(latencies, 95).toFixed(0)} ms · max ${latencies.at(-1)!.toFixed(0)} ms`,
    );
    await sleep(500);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const s of sockets) s.destroy();
    server.kill();
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500);
  });
