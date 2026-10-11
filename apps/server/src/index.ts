import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Snapshot } from '@nemeton/shared';
import { createApp } from './app';
import { Store } from './store';

export const DEFAULT_DB = fileURLToPath(new URL('../../../data/nemeton.db', import.meta.url));
export const SEED = fileURLToPath(new URL('../../../data/seed/festival.json', import.meta.url));

export function openStore(path = process.env.NEMETON_DB ?? DEFAULT_DB): Store {
  // An empty database starts from the seed file; after that, changes come through the change log.
  return Store.open(path, () => Snapshot.parse(JSON.parse(readFileSync(SEED, 'utf8'))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const store = openStore();
  const port = Number(process.env.API_PORT ?? 8787);
  serve({ fetch: createApp(store).fetch, port }, ({ port }) => {
    const { festival, sessions } = store.snapshot();
    console.log(
      `${festival.name}: ${sessions.length} sessions at seq ${store.seq}, serving on http://localhost:${port}/api`,
    );
  });
}
