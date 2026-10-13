import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import * as z from 'zod/mini';
import {
  ChangeInput,
  FESTIVAL_ID,
  applyChanges,
  parseEntity,
  slugify,
  type Change,
  type DeviceRegistration,
  type EntityKind,
  type ItineraryOp,
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
  -- Attendee itineraries: one row per (user, session), last writer (by HLC) wins.
  CREATE TABLE IF NOT EXISTS itinerary (
    user_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL,
    hlc TEXT NOT NULL, device_id TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, session_id)
  );
  -- Op ids already applied, so a retried request changes nothing.
  CREATE TABLE IF NOT EXISTS applied_ops (
    op_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, applied_at TEXT NOT NULL
  );
`;

export interface Device {
  userId: string;
  deviceId: string;
}

export interface SessionPopularity {
  sessionId: string;
  count: number;
}

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
    const parsed = z.array(ChangeInput).check(z.minLength(1)).safeParse(input);
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

  // ---------- attendee devices and itineraries ----------

  /** Signing key for device tokens. Created on first use; resetting the database invalidates them. */
  private deviceSecret(): Buffer {
    const existing = this.db.prepare(`SELECT value FROM meta WHERE key = 'device_secret'`).get() as
      { value: string } | undefined;
    if (existing) return Buffer.from(existing.value, 'base64url');
    const secret = randomBytes(32);
    this.setMeta('device_secret', secret.toString('base64url'));
    return secret;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.deviceSecret()).update(payload).digest('base64url');
  }

  /**
   * An anonymous identity for a new install. No account or personal data: the token just proves
   * later requests come from the same itinerary. The server picks the user id so nobody can claim
   * someone else's; the device id is the client's own (it already stamps its clock with it).
   */
  registerDevice(deviceId: string): DeviceRegistration {
    if (!/^[\w-]{8,64}$/.test(deviceId)) throw new StoreError('Invalid device id', 422);
    const userId = randomUUID();
    const payload = Buffer.from(JSON.stringify({ u: userId, d: deviceId })).toString('base64url');
    return { userId, deviceId, token: `dev_${payload}.${this.sign(payload)}` };
  }

  /** The device a token was issued to, if the signature checks out. */
  verifyDevice(token: string): Device | null {
    const m = /^dev_([\w-]+)\.([\w-]+)$/.exec(token);
    if (!m) return null;
    const expected = Buffer.from(this.sign(m[1]!));
    const actual = Buffer.from(m[2]!);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try {
      const { u, d } = JSON.parse(Buffer.from(m[1]!, 'base64url').toString()) as {
        u: string;
        d: string;
      };
      return { userId: u, deviceId: d };
    } catch {
      return null;
    }
  }

  /**
   * Applies itinerary ops idempotently. An op id seen before is skipped. Otherwise the op wins
   * if its HLC is newer than what's stored, so a late-arriving older op can't undo a newer one.
   */
  applyItineraryOps(device: Device, ops: ItineraryOp[]): { applied: number; duplicates: number } {
    return this.transaction(() => {
      const seen = this.db.prepare('SELECT 1 FROM applied_ops WHERE op_id = ?');
      const record = this.db.prepare(
        'INSERT INTO applied_ops (op_id, user_id, applied_at) VALUES (?, ?, ?)',
      );
      const current = this.db.prepare(
        'SELECT hlc FROM itinerary WHERE user_id = ? AND session_id = ?',
      );
      const upsert = this.db.prepare(`
        INSERT INTO itinerary (user_id, session_id, state, hlc, device_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, session_id) DO UPDATE SET
          state = excluded.state, hlc = excluded.hlc,
          device_id = excluded.device_id, updated_at = excluded.updated_at
      `);
      const now = new Date().toISOString();
      let applied = 0;
      let duplicates = 0;
      for (const op of [...ops].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))) {
        if (seen.get(op.opId)) {
          duplicates++;
          continue;
        }
        record.run(op.opId, device.userId, now);
        const stored = current.get(device.userId, op.sessionId) as { hlc: string } | undefined;
        if (!stored || op.hlc > stored.hlc) {
          upsert.run(device.userId, op.sessionId, op.state, op.hlc, device.deviceId, now);
        }
        applied++;
      }
      return { applied, duplicates };
    });
  }

  /** The sessions a user has in their itinerary (for tests and, in v2, other devices). */
  itinerary(userId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT session_id FROM itinerary WHERE user_id = ? AND state = 'added' ORDER BY session_id`,
        )
        .all(userId) as { session_id: string }[]
    ).map((r) => r.session_id);
  }

  /** How many attendees have each session in their itinerary. Anonymous counts only. */
  popularity(): SessionPopularity[] {
    return (
      this.db
        .prepare(
          `SELECT session_id, COUNT(*) AS count FROM itinerary WHERE state = 'added'
           GROUP BY session_id ORDER BY count DESC, session_id`,
        )
        .all() as { session_id: string; count: number }[]
    ).map((r) => ({ sessionId: r.session_id, count: Number(r.count) }));
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
