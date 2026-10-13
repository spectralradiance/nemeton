import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Snapshot } from '@nemeton/shared';
import { Store } from './store';

// A database created by an older server must open with the current code, keeping its schedule,
// change log and organizers, and gaining the newer tables.

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('SQLite upgrades', () => {
  it('opens a Phase 3 database (no itinerary tables, no device key) without losing data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nemeton-migrate-'));
    dirs.push(dir);
    const path = join(dir, 'old.db');

    // Exactly what the Phase 3 server created.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id));
      CREATE TABLE changes (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL, data TEXT,
        at TEXT NOT NULL, author TEXT NOT NULL
      );
      CREATE TABLE organizers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, revoked_at TEXT
      );
    `);
    const put = old.prepare('INSERT INTO entities (kind, id, data) VALUES (?, ?, ?)');
    put.run('festival', 'festival', JSON.stringify(seed.festival));
    for (const s of seed.stages) put.run('stage', s.id, JSON.stringify(s));
    for (const s of seed.sessions) put.run('session', s.id, JSON.stringify(s));
    for (const v of seed.vendors) put.run('vendor', v.id, JSON.stringify(v));
    old.prepare(`INSERT INTO meta VALUES ('epoch', 'phase-3-epoch'), ('min_seq', '0')`).run();
    old
      .prepare(
        `INSERT INTO changes (entity, entity_id, op, data, at, author) VALUES ('vendor', 'corviid', 'delete', NULL, '2026-10-11T00:00:00.000Z', 'Old Organizer')`,
      )
      .run();
    old.close();

    const store = Store.open(path); // no seed: it must find the existing schedule
    expect(store.epoch).toBe('phase-3-epoch');
    expect(store.seq).toBe(1);
    expect(store.log()[0]).toMatchObject({ author: 'Old Organizer', id: 'corviid' });
    expect(store.snapshot().sessions).toHaveLength(seed.sessions.length);

    // Newer features work on the upgraded database.
    const device = store.registerDevice(crypto.randomUUID());
    expect(store.verifyDevice(device.token)).toMatchObject({ userId: device.userId });
    store.close();
  });
});
