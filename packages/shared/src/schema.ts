import { z } from 'zod';

/** A calendar date in the festival's timezone, e.g. "2026-06-19". */
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** A UTC instant, e.g. "2026-06-19T21:00:00.000Z". */
const UtcInstant = z.iso.datetime();

export const FestivalDay = z.object({
  /** Calendar date the festival day starts on. Late-night sets after midnight still belong to it. */
  date: IsoDate,
  label: z.string(),
});
export type FestivalDay = z.infer<typeof FestivalDay>;

export const Festival = z.object({
  name: z.string(),
  /** IANA zone. All times are displayed in this zone, never the device's. */
  timezone: z.string(),
  /** Minutes after local midnight when one festival day rolls over to the next (e.g. 360 = 06:00). */
  dayBoundaryMinutes: z.number().int().min(0).max(720),
  days: z.array(FestivalDay).min(1),
});
export type Festival = z.infer<typeof Festival>;

export const Stage = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int(),
});
export type Stage = z.infer<typeof Stage>;

export const LinkKind = z.enum(['bandcamp', 'instagram', 'facebook', 'youtube', 'website']);
export type LinkKind = z.infer<typeof LinkKind>;

/** A list rather than one field per kind: a shared session can have several people's accounts. */
export const Link = z.object({ kind: LinkKind, url: z.url() });
export type Link = z.infer<typeof Link>;

export const SessionKind = z.enum(['music', 'ritual', 'workshop']);
export type SessionKind = z.infer<typeof SessionKind>;

export const SessionStatus = z.enum(['scheduled', 'delayed', 'moved', 'cancelled']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const Session = z.object({
  id: z.string(),
  kind: SessionKind,
  title: z.string(),
  /** Longer form of the title, e.g. "In Defense of the World Tree". */
  subtitle: z.string().optional(),
  /** Qualifiers pulled out of the title, e.g. "drop-in", "family programming". */
  tags: z.array(z.string()),
  /** Festival day this session belongs to (FestivalDay.date). */
  day: IsoDate,
  /** null = runs all day ("Ongoing"). */
  startsAt: UtcInstant.nullable(),
  /** null = end time not published; the UI estimates one. */
  endsAt: UtcInstant.nullable(),
  stageId: z.string(),
  /** Performers or workshop facilitators. */
  people: z.array(z.string()),
  /** Where the act is from, e.g. "Oregon". */
  origin: z.string().optional(),
  /** What the session is about. Paragraphs are separated by blank lines. */
  description: z.string().optional(),
  /** About the performers or facilitators. Paragraphs are separated by blank lines. */
  bio: z.string().optional(),
  photo: z.url().optional(),
  links: z.array(Link),
  status: SessionStatus,
  note: z.string().optional(),
});
export type Session = z.infer<typeof Session>;

export const Vendor = z.object({
  id: z.string(),
  name: z.string(),
  links: z.array(Link),
});
export type Vendor = z.infer<typeof Vendor>;

const SnapshotFields = z.object({
  /** Change-log sequence number this snapshot reflects. */
  seq: z.number().int().min(0),
  festival: Festival,
  stages: z.array(Stage),
  sessions: z.array(Session),
  vendors: z.array(Vendor),
});

/** Cross-record checks: unique ids, and sessions pointing at real stages and festival days. */
function checkReferences(snap: z.infer<typeof SnapshotFields>, ctx: z.RefinementCtx) {
  const stageIds = new Set(snap.stages.map((s) => s.id));
  const days = new Set(snap.festival.days.map((d) => d.date));
  for (const [list, name] of [
    [snap.stages, 'stages'],
    [snap.sessions, 'sessions'],
    [snap.vendors, 'vendors'],
  ] as const) {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      if (seen.has(item.id))
        ctx.addIssue({
          code: 'custom',
          path: [name, i, 'id'],
          message: `duplicate id "${item.id}"`,
        });
      seen.add(item.id);
    });
  }
  snap.sessions.forEach((s, i) => {
    if (!stageIds.has(s.stageId))
      ctx.addIssue({
        code: 'custom',
        path: ['sessions', i, 'stageId'],
        message: `unknown stage "${s.stageId}"`,
      });
    if (!days.has(s.day))
      ctx.addIssue({
        code: 'custom',
        path: ['sessions', i, 'day'],
        message: `unknown festival day "${s.day}"`,
      });
  });
}

export const Snapshot = SnapshotFields.superRefine(checkReferences);
export type Snapshot = z.infer<typeof Snapshot>;

/**
 * What the server sends: a snapshot plus the epoch of the database it came from. A new epoch
 * (e.g. the server's data was reset) means local seq numbers mean nothing and must be discarded.
 */
export const SnapshotResponse = SnapshotFields.extend({ epoch: z.string() }).superRefine(
  checkReferences,
);
export type SnapshotResponse = z.infer<typeof SnapshotResponse>;
