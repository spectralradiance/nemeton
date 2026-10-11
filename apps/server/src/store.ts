import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ChangeInput,
  FESTIVAL_ID,
  applyChanges,
  parseEntity,
  slugify,
  type Change,
  type EntityKind,
  type Snapshot,
} from '@nemeton/shared';

// Server-side source of truth. Official schedule data only changes through apply(), which validates
// the whole resulting schedule, writes the entities and appends to the change log in one
// transaction. Clients catch up by asking for changes after the seq they hold.

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status: 409 | 422,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface Organizer {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface ApplyResult {
  from: number;
  to: number;
  changes: Change[];
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS entities (
    kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL, entity_id TEXT NOT NULL, op TEXT NOT NULL, data TEXT,
    at TEXT NOT NULL, author TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS organizers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, revoked_at TEXT
  );
`;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export class Store {
  private constructor(private readonly db: DatabaseSync) {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
  }

  /** Opens (or creates) the database. `seed` provides the initial schedule for an empty one. */
  static open(path: string, seed?: () => Snapshot): Store {
    const store = new Store(new DatabaseSync(path));
    if (!store.isSeeded()) {
      if (!seed) throw new Error(`${path} has no schedule and no seed was given`);
      store.seed(seed());
    }
    return store;
  }

  close() {
    this.db.close();
  }

  private isSeeded(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM entities WHERE kind = 'festival'`).get();
  }

  /** Loads a baseline schedule at seq 0 and starts a new epoch. */
  private seed(snapshot: Snapshot) {
    this.transaction(() => {
      const put = this.db.prepare('INSERT INTO entities (kind, id, data) VALUES (?, ?, ?)');
      put.run('festival', FESTIVAL_ID, JSON.stringify(snapshot.festival));
      for (const s of snapshot.stages) put.run('stage', s.id, JSON.stringify(s));
      for (const s of snapshot.sessions) put.run('session', s.id, JSON.stringify(s));
      for (const v of snapshot.vendors) put.run('vendor', v.id, JSON.stringify(v));
      this.setMeta('epoch', randomUUID());
      this.setMeta('min_seq', '0');
    });
  }

  private setMeta(key: string, value: string) {
    this.db
      .prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  private getMeta(key: string): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) throw new Error(`missing meta "${key}"`);
    return row.value;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Identifies this database. A new epoch tells clients their seq numbers are meaningless. */
  get epoch(): string {
    return this.getMeta('epoch');
  }

  get seq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM changes').get() as {
      seq: number | null;
    };
    return row.seq ?? 0;
  }

  snapshot(): Snapshot {
    const rows = (kind: EntityKind) =>
      (
        this.db.prepare('SELECT data FROM entities WHERE kind = ? ORDER BY rowid').all(kind) as {
          data: string;
        }[]
      ).map((r) => JSON.parse(r.data));
    const [festival] = rows('festival');
    return {
      seq: this.seq,
      festival,
      stages: rows('stage').sort((a, b) => a.order - b.order),
      sessions: rows('session'),
      vendors: rows('vendor'),
    };
  }

  /** Changes after `since`, or null if the log can't bridge the gap and a full snapshot is needed. */
  changesSince(since: number): Change[] | null {
    if (since > this.seq || since < Number(this.getMeta('min_seq'))) return null;
    const rows = this.db
      .prepare(
        'SELECT seq, entity, entity_id, op, data, at, author FROM changes WHERE seq > ? ORDER BY seq',
      )
      .all(since) as unknown as ChangeRow[];
    return rows.map(toChange);
  }

  /** Most recent changes first. */
  log(limit = 50): Change[] {
    const rows = this.db
      .prepare(
        'SELECT seq, entity, entity_id, op, data, at, author FROM changes ORDER BY seq DESC LIMIT ?',
      )
      .all(limit) as unknown as ChangeRow[];
    return rows.map(toChange);
  }

  /**
   * Validates and applies changes atomically, appending them to the log.
   * With `baseSeq`, refuses (409) if anything changed since the caller looked.
   */
  apply(input: unknown[], author: string, baseSeq?: number): ApplyResult {
    const parsed = ChangeInput.array().min(1).safeParse(input);
    if (!parsed.success) throw new StoreError('Malformed changes', 422, parsed.error.issues);
    const changes = parsed.data;

    return this.transaction(() => {
      const from = this.seq;
      if (baseSeq !== undefined && baseSeq !== from) {
        throw new StoreError(
          `The schedule changed since you looked (you had ${baseSeq}, it's now ${from}). Review again.`,
          409,
          { seq: from },
        );
      }
      try {
        applyChanges(this.snapshot(), changes);
      } catch (err) {
        throw new StoreError(`Invalid change: ${(err as Error).message}`, 422);
      }

      const at = new Date().toISOString();
      const upsert = this.db.prepare(
        'INSERT INTO entities (kind, id, data) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data',
      );
      const remove = this.db.prepare('DELETE FROM entities WHERE kind = ? AND id = ?');
      const log = this.db.prepare(
        'INSERT INTO changes (entity, entity_id, op, data, at, author) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const written: Change[] = [];
      for (const c of changes) {
        if (c.op === 'upsert') {
          const data = parseEntity(c);
          upsert.run(c.entity, c.id, JSON.stringify(data));
          const { lastInsertRowid } = log.run(
            c.entity,
            c.id,
            'upsert',
            JSON.stringify(data),
            at,
            author,
          );
          written.push({ ...c, data, seq: Number(lastInsertRowid), at, author });
        } else {
          remove.run(c.entity, c.id);
          const { lastInsertRowid } = log.run(c.entity, c.id, 'delete', null, at, author);
          written.push({ ...c, seq: Number(lastInsertRowid), at, author });
        }
      }
      return { from, to: this.seq, changes: written };
    });
  }

  // ---------- organizers ----------

  /** Creates an organizer and returns their token. Only its hash is stored: show it once. */
  addOrganizer(name: string): Organizer & { token: string } {
    const id = `${slugify(name) || 'organizer'}-${randomBytes(3).toString('hex')}`;
    const token = `nmt_${randomBytes(24).toString('base64url')}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT INTO organizers (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, hashToken(token), createdAt);
    return { id, name, createdAt, revokedAt: null, token };
  }

  listOrganizers(): Organizer[] {
    return (
      this.db
        .prepare('SELECT id, name, created_at, revoked_at FROM organizers ORDER BY created_at')
        .all() as { id: string; name: string; created_at: string; revoked_at: string | null }[]
    ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, revokedAt: r.revoked_at }));
  }

  revokeOrganizer(id: string): boolean {
    const { changes } = this.db
      .prepare('UPDATE organizers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), id);
    return Number(changes) > 0;
  }

  /** The organizer a token belongs to, if it's valid and not revoked. */
  authenticate(token: string): Organizer | null {
    const row = this.db
      .prepare(
        'SELECT id, name, created_at, revoked_at FROM organizers WHERE token_hash = ? AND revoked_at IS NULL',
      )
      .get(hashToken(token)) as
      { id: string; name: string; created_at: string; revoked_at: null } | undefined;
    return row ? { id: row.id, name: row.name, createdAt: row.created_at, revokedAt: null } : null;
  }
}

interface ChangeRow {
  seq: number;
  entity: EntityKind;
  entity_id: string;
  op: 'upsert' | 'delete';
  data: string | null;
  at: string;
  author: string;
}

function toChange(r: ChangeRow): Change {
  const base = { seq: r.seq, entity: r.entity, id: r.entity_id, at: r.at, author: r.author };
  return r.op === 'upsert'
    ? { ...base, op: 'upsert', data: JSON.parse(r.data!) }
    : { ...base, op: 'delete' };
}
