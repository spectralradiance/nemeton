import Dexie, { type EntityTable } from 'dexie';
import type { Festival, Session, Snapshot, Stage, Vendor } from '@nemeton/shared';

/**
 * Bump when the shape of stored records changes. Older data is then ignored and re-downloaded,
 * which is always safe for server-owned schedule data. (Itinerary tables, added in Phase 5, will
 * need real Dexie migrations instead.)
 */
export const DATA_VERSION = 1;

export interface SyncMeta {
  key: 'sync';
  dataVersion: number;
  /** Change-log position of the stored schedule. Never moves backwards. */
  seq: number;
  etag: string | null;
  /** When the server last confirmed this data was current. */
  syncedAt: number;
}

type FestivalRow = Festival & { key: 'festival' };

export class NemetonDB extends Dexie {
  festival!: EntityTable<FestivalRow, 'key'>;
  stages!: EntityTable<Stage, 'id'>;
  sessions!: EntityTable<Session, 'id'>;
  vendors!: EntityTable<Vendor, 'id'>;
  meta!: EntityTable<SyncMeta, 'key'>;

  constructor(name = 'nemeton') {
    super(name);
    this.version(1).stores({
      festival: 'key',
      stages: 'id',
      sessions: 'id, day, stageId',
      vendors: 'id',
      meta: 'key',
    });
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
  etag: string | null,
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
          seq: snapshot.seq,
          etag,
          syncedAt: Date.now(),
        }),
      ]);
    },
  );
}
