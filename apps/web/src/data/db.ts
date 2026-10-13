import Dexie, { type EntityTable } from 'dexie';
import {
  FESTIVAL_ID,
  parseEntity,
  type ChangesResponse,
  type Festival,
  type ItineraryOp,
  type ItineraryState,
  type Session,
  type Snapshot,
  type Stage,
  type Vendor,
} from '@nemeton/shared';

/**
 * Bump when the shape of stored records changes. Older data is then ignored and re-downloaded,
 * which is always safe for server-owned schedule data. (Itinerary tables, added in Phase 5, will
 * need real Dexie migrations instead.)
 */
export const DATA_VERSION = 2;

export interface SyncMeta {
  key: 'sync';
  dataVersion: number;
  /** Which server database the data came from; seq numbers only mean something within one. */
  epoch: string;
  /** Change-log position of the stored schedule. Never moves backwards within an epoch. */
  seq: number;
  /** When the server last confirmed this data was current. */
  syncedAt: number;
}

type FestivalRow = Festival & { key: 'festival' };

/**
 * One official change to a session, for the Updates feed and change toasts. `before` is known for
 * changes this device applied itself; history downloaded with a fresh install only has `after`.
 */
export interface FeedItem {
  seq: number;
  at: string;
  sessionId: string;
  op: 'upsert' | 'delete';
  before?: Session;
  after?: Session;
  /** A session that didn't exist before this change. Unknown (undefined) for downloaded history. */
  added?: boolean;
}

/** A session in (or removed from) the attendee's plan. Owned by this device: "client wins". */
export interface ItineraryItem {
  sessionId: string;
  state: ItineraryState;
  hlc: string;
  updatedAt: number;
  /** Title when saved, to name it if the organizers later remove the session. */
  title?: string;
}

/** An itinerary edit not yet confirmed by the server. */
export interface OutboxOp extends ItineraryOp {
  createdAt: number;
  attempts: number;
}

/** This install's identity: a local id for the clock, and the server's anonymous registration. */
export interface DeviceRow {
  key: 'device';
  deviceId: string;
  /** Last HLC issued here, so the clock never goes backwards across reloads. */
  hlc: string | null;
  userId?: string;
  token?: string;
}

/** How many feed items to keep on the device. */
export const FEED_LIMIT = 200;

export class NemetonDB extends Dexie {
  festival!: EntityTable<FestivalRow, 'key'>;
  stages!: EntityTable<Stage, 'id'>;
  sessions!: EntityTable<Session, 'id'>;
  vendors!: EntityTable<Vendor, 'id'>;
  meta!: EntityTable<SyncMeta, 'key'>;
  feed!: EntityTable<FeedItem, 'seq'>;
  itinerary!: EntityTable<ItineraryItem, 'sessionId'>;
  outbox!: EntityTable<OutboxOp, 'opId'>;
  device!: EntityTable<DeviceRow, 'key'>;

  constructor(name = 'nemeton') {
    super(name);
    this.version(1).stores({
      festival: 'key',
      stages: 'id',
      sessions: 'id, day, stageId',
      vendors: 'id',
      meta: 'key',
    });
    this.version(2).stores({ feed: 'seq' });
    this.version(3).stores({ itinerary: 'sessionId, state', outbox: 'opId, createdAt', device: 'key' });
    // v4: the outbox is sent in clock order (unique and increasing), not creation time (ties).
    this.version(4).stores({ outbox: 'opId, createdAt, hlc' });
  }
}

export const db = new NemetonDB();

/** The stored schedule, or null if there is none (or it's from an older app version). */
export async function readSnapshot(database: NemetonDB): Promise<Snapshot | null> {
  return database.transaction(
    'r',
    [database.festival, database.stages, database.sessions, database.vendors, database.meta],
    async () => {
      const [meta, festivalRow, stages, sessions, vendors] = await Promise.all([
        database.meta.get('sync'),
        database.festival.get('festival'),
        database.stages.toArray(),
        database.sessions.toArray(),
        database.vendors.toArray(),
      ]);
      if (!meta || !festivalRow || meta.dataVersion !== DATA_VERSION) return null;
      const { key: _key, ...festival } = festivalRow;
      return {
        seq: meta.seq,
        festival,
        stages: stages.sort((a, b) => a.order - b.order),
        sessions,
        vendors,
      };
    },
  );
}

/** Replaces the stored schedule in one transaction, so readers never see half of an update. */
export async function writeSnapshot(
  database: NemetonDB,
  snapshot: Snapshot,
  epoch: string,
): Promise<void> {
  await database.transaction(
    'rw',
    [database.festival, database.stages, database.sessions, database.vendors, database.meta],
    async () => {
      await Promise.all([
        database.stages.clear(),
        database.sessions.clear(),
        database.vendors.clear(),
      ]);
      await Promise.all([
        database.festival.put({ ...snapshot.festival, key: 'festival' }),
        database.stages.bulkPut(snapshot.stages),
        database.sessions.bulkPut(snapshot.sessions),
        database.vendors.bulkPut(snapshot.vendors),
        database.meta.put({
          key: 'sync',
          dataVersion: DATA_VERSION,
          epoch,
          seq: snapshot.seq,
          syncedAt: Date.now(),
        }),
      ]);
    },
  );
}

export class OutOfSyncError extends Error {}

/**
 * Applies a batch of changes in one transaction, in seq order. Refuses (OutOfSyncError) unless the
 * batch starts exactly where the stored data is, so a gap or a stale response can't corrupt it.
 */
export async function applyChangesToDb(
  database: NemetonDB,
  batch: ChangesResponse,
): Promise<FeedItem[]> {
  const started = performance.now();
  const feed = await database.transaction(
    'rw',
    [
      database.festival,
      database.stages,
      database.sessions,
      database.vendors,
      database.meta,
      database.feed,
    ],
    async () => {
      const meta = await database.meta.get('sync');
      if (!meta || meta.dataVersion !== DATA_VERSION || meta.epoch !== batch.epoch) {
        throw new OutOfSyncError('Stored schedule is from a different server database');
      }
      if (meta.seq !== batch.from) {
        throw new OutOfSyncError(`Expected changes after ${meta.seq}, got after ${batch.from}`);
      }
      const tables = {
        stage: database.stages,
        session: database.sessions,
        vendor: database.vendors,
      } as const;
      const feed: FeedItem[] = [];
      for (const c of [...batch.changes].sort((a, b) => a.seq - b.seq)) {
        if (c.entity === 'session') {
          const before = await database.sessions.get(c.id);
          const after = c.op === 'upsert' ? (parseEntity(c) as Session) : undefined;
          feed.push({
            seq: c.seq,
            at: c.at,
            sessionId: c.id,
            op: c.op,
            before,
            after,
            added: c.op === 'upsert' && !before,
          });
        }
        if (c.entity === 'festival') {
          if (c.op === 'upsert') {
            await database.festival.put({ ...(parseEntity(c) as Festival), key: FESTIVAL_ID });
          }
        } else if (c.op === 'delete') {
          await tables[c.entity].delete(c.id);
        } else {
          // Validated with the same schema the server used; throws (and rolls back) if this app
          // version can't understand the data.
          await (tables[c.entity] as typeof database.sessions).put(parseEntity(c) as Session);
        }
      }
      await database.meta.update('sync', { seq: batch.to, syncedAt: Date.now() });
      await addToFeed(database, feed);
      return feed;
    },
  );
  // Visible in the browser's performance timeline; the e2e budget test reads it.
  performance.measure('nemeton:apply-changes', {
    start: started,
    end: performance.now(),
    detail: { count: batch.changes.length },
  });
  return feed;
}

/** Adds feed items, keeping only the newest FEED_LIMIT. */
export async function addToFeed(database: NemetonDB, items: FeedItem[]): Promise<void> {
  if (items.length === 0) return;
  await database.feed.bulkPut(items);
  const excess = (await database.feed.count()) - FEED_LIMIT;
  if (excess > 0) {
    const oldest = await database.feed.orderBy('seq').limit(excess).primaryKeys();
    await database.feed.bulkDelete(oldest);
  }
}
