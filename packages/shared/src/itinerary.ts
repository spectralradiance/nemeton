import * as z from 'zod/mini';
import type { Session } from './schema';
import type { SessionEnd } from './schedule';

// Personal itineraries are owned by the attendee ("client wins"). Each add/remove is an op with a
// unique id (so retries are applied once) and a Hybrid Logical Clock stamp (so the latest intent
// wins, even arriving late from an offline device; v1 has one device per person, v2 merges several).

export const ItineraryState = z.enum(['added', 'removed']);
export type ItineraryState = z.infer<typeof ItineraryState>;

export const ItineraryOp = z.object({
  /** Idempotency key: the server applies each op id at most once. */
  opId: z.uuid(),
  sessionId: z.string().check(z.minLength(1)),
  /** 'removed' is a tombstone: it must win over an older 'added' from anywhere. */
  state: ItineraryState,
  hlc: z.string().check(z.regex(/^[0-9a-z]{11}-[0-9a-z]{4}-.+$/)),
});
export type ItineraryOp = z.infer<typeof ItineraryOp>;

export const ItineraryOpsRequest = z.object({
  ops: z.array(ItineraryOp).check(z.minLength(1), z.maxLength(500)),
});

export const DeviceRegistration = z.object({
  userId: z.string(),
  deviceId: z.string(),
  token: z.string(),
});
export type DeviceRegistration = z.infer<typeof DeviceRegistration>;

// ---------- Hybrid Logical Clock ----------
//
// "<wall ms, base36, 11 chars>-<counter, base36, 4 chars>-<node id>". Fixed widths make plain
// string comparison match time order. The wall part never goes backwards, even if the device clock
// does, and the counter orders events within one millisecond.

const WALL = 11;
const COUNTER = 4;

function parseHlc(hlc: string): [wall: number, counter: number] {
  return [parseInt(hlc.slice(0, WALL), 36), parseInt(hlc.slice(WALL + 1, WALL + 1 + COUNTER), 36)];
}

/** The next timestamp for `node`, strictly greater than `last`. */
export function tickHlc(last: string | null | undefined, node: string, now = Date.now()): string {
  const [lastWall, lastCounter] = last ? parseHlc(last) : [0, -1];
  const wall = Math.max(now, lastWall);
  const counter = wall === lastWall ? lastCounter + 1 : 0;
  return `${wall.toString(36).padStart(WALL, '0')}-${counter.toString(36).padStart(COUNTER, '0')}-${node}`;
}

/** Wall-clock time an HLC was taken at. */
export function hlcTime(hlc: string): number {
  return parseHlc(hlc)[0];
}

// ---------- clashes ----------

/**
 * For each timed session, the other sessions in the list it overlaps with. All-day sessions and
 * cancelled ones never clash. Back-to-back sessions (one ends as the next starts) don't clash.
 */
export function findClashes(
  sessions: readonly Session[],
  ends: Map<string, SessionEnd>,
): Map<string, Session[]> {
  const timed = sessions
    .filter((s) => s.startsAt && s.status !== 'cancelled' && ends.has(s.id))
    .map((s) => ({ s, start: Date.parse(s.startsAt!), end: Date.parse(ends.get(s.id)!.endsAt) }))
    .sort((a, b) => a.start - b.start);
  const clashes = new Map<string, Session[]>();
  const add = (a: Session, b: Session) => clashes.set(a.id, [...(clashes.get(a.id) ?? []), b]);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j]!.start < timed[i]!.end; j++) {
      add(timed[i]!.s, timed[j]!.s);
      add(timed[j]!.s, timed[i]!.s);
    }
  }
  return clashes;
}
