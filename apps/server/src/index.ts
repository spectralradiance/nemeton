import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Snapshot } from '@nemeton/shared';
import { createApp } from './app';

const seedPath = new URL('../../../data/seed/festival.json', import.meta.url);
const port = Number(process.env.API_PORT ?? 8787);

let snapshot: Snapshot;
try {
  snapshot = Snapshot.parse(JSON.parse(readFileSync(seedPath, 'utf8')));
} catch (err) {
  console.error(`Couldn't load ${seedPath.pathname}. Run \`npm run import:csv\` first.\n`, err);
  process.exit(1);
}

serve({ fetch: createApp(snapshot).fetch, port }, ({ port }) => {
  console.log(
    `${snapshot.festival.name}: ${snapshot.sessions.length} sessions, serving on http://localhost:${port}/api`,
  );
});
