import { z } from 'zod';
import { Festival, Session, Snapshot, Stage, Vendor } from './schema';

// The change log is the only way official schedule data changes. Every change has a seq number;
// clients hold the seq they're up to and fetch everything after it.

export const EntityKind = z.enum(['festival', 'stage', 'session', 'vendor']);
export type EntityKind = z.infer<typeof EntityKind>;

export const ENTITY_SCHEMA = {
  festival: Festival,
  stage: Stage,
  session: Session,
  vendor: Vendor,
} as const;

/** The festival is a singleton; its change entries use this id. */
export const FESTIVAL_ID = 'festival' as const;

export const ChangeInput = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('upsert'),
    entity: EntityKind,
    id: z.string().min(1),
    data: z.unknown(),
  }),
  z.object({ op: z.literal('delete'), entity: EntityKind, id: z.string().min(1) }),
]);
export type ChangeInput = z.infer<typeof ChangeInput>;

export const Change = z.intersection(
  ChangeInput,
  z.object({
    seq: z.number().int().positive(),
    at: z.iso.datetime(),
    /** Organizer who made the change. */
    author: z.string(),
  }),
);
export type Change = z.infer<typeof Change>;

export const ChangesResponse = z.object({
  epoch: z.string(),
  /** The `since` the client asked for. */
  from: z.number().int().min(0),
  /** The server's latest seq; the client is up to date at this point after applying. */
  to: z.number().int().min(0),
  changes: z.array(Change),
});
export type ChangesResponse = z.infer<typeof ChangesResponse>;

/** Validates an upsert's data against its entity's schema, and that the id inside matches. */
export function parseEntity(change: Extract<ChangeInput, { op: 'upsert' }>) {
  const data = ENTITY_SCHEMA[change.entity].parse(change.data);
  const id = 'id' in data ? data.id : FESTIVAL_ID;
  if (id !== change.id)
    throw new Error(`${change.entity} id "${id}" doesn't match change id "${change.id}"`);
  return data;
}

const LIST = { stage: 'stages', session: 'sessions', vendor: 'vendors' } as const;

/** Applies changes to a snapshot without mutating it. Throws if the result is inconsistent. */
export function applyChanges(
  snapshot: Snapshot,
  changes: readonly ChangeInput[],
  seq?: number,
): Snapshot {
  const next = {
    ...snapshot,
    stages: [...snapshot.stages],
    sessions: [...snapshot.sessions],
    vendors: [...snapshot.vendors],
  };
  for (const c of changes) {
    if (c.entity === 'festival') {
      if (c.op === 'delete') throw new Error("The festival can't be deleted");
      next.festival = parseEntity(c) as Festival;
      continue;
    }
    const key = LIST[c.entity];
    const list = next[key] as Array<{ id: string }>;
    const i = list.findIndex((x) => x.id === c.id);
    if (c.op === 'delete') {
      if (i !== -1) list.splice(i, 1);
    } else {
      const data = parseEntity(c) as { id: string };
      if (i === -1) list.push(data);
      else list[i] = data;
    }
  }
  if (seq !== undefined) next.seq = seq;
  return Snapshot.parse(next);
}

/** Order-independent JSON, so equal records compare equal however their keys were written. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * The changes that turn `before` into `after`. Stages are upserted first and deleted last, so
 * every intermediate state keeps sessions pointing at stages that exist.
 */
export function diffSnapshots(before: Snapshot, after: Snapshot): ChangeInput[] {
  const changes: ChangeInput[] = [];
  if (stable(before.festival) !== stable(after.festival)) {
    changes.push({ op: 'upsert', entity: 'festival', id: FESTIVAL_ID, data: after.festival });
  }
  const upserts: ChangeInput[] = [];
  const deletes: ChangeInput[] = [];
  for (const entity of ['stage', 'session', 'vendor'] as const) {
    const old = new Map<string, unknown>(before[LIST[entity]].map((x) => [x.id, x]));
    const now = new Map<string, unknown>(after[LIST[entity]].map((x) => [x.id, x]));
    for (const [id, data] of now) {
      if (!old.has(id) || stable(old.get(id)) !== stable(data))
        upserts.push({ op: 'upsert', entity, id, data });
    }
    for (const id of old.keys()) if (!now.has(id)) deletes.push({ op: 'delete', entity, id });
  }
  // Session deletes before stage deletes; stage upserts before session upserts (already in order).
  deletes.sort((a, b) => Number(a.entity === 'stage') - Number(b.entity === 'stage'));
  return [...changes, ...upserts, ...deletes];
}
