import type { Festival, Session, SessionKind } from './schema';
import { addDays, zonedToUtc } from './time';

/** Assumed length when the organizers haven't published an end time. */
export const DEFAULT_MINUTES: Record<SessionKind, number> = {
  music: 45,
  ritual: 60,
  workshop: 60,
};

export interface SessionEnd {
  endsAt: string;
  /** True when the end is a guess rather than published. */
  estimated: boolean;
}

/**
 * End time for every timed session. Published ends are used as-is. Otherwise a session runs until
 * the next one on the same stage, or for its kind's default length, whichever is sooner.
 */
export function estimateEnds(sessions: readonly Session[]): Map<string, SessionEnd> {
  const byStageDay = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!s.startsAt) continue;
    const key = `${s.day}|${s.stageId}`;
    byStageDay.set(key, [...(byStageDay.get(key) ?? []), s]);
  }

  const ends = new Map<string, SessionEnd>();
  for (const group of byStageDay.values()) {
    group.sort((a, b) => a.startsAt!.localeCompare(b.startsAt!));
    group.forEach((s, i) => {
      if (s.endsAt) {
        ends.set(s.id, { endsAt: s.endsAt, estimated: false });
        return;
      }
      const start = Date.parse(s.startsAt!);
      const cap = start + DEFAULT_MINUTES[s.kind] * 60_000;
      const next = group.slice(i + 1).find((n) => Date.parse(n.startsAt!) > start);
      const end = next ? Math.min(cap, Date.parse(next.startsAt!)) : cap;
      ends.set(s.id, { endsAt: new Date(end).toISOString(), estimated: true });
    });
  }
  return ends;
}

/** UTC bounds of a festival day: from its day boundary to the next day's boundary. */
export function festivalDayBounds(
  festival: Festival,
  date: string,
): { start: number; end: number } {
  return {
    start: zonedToUtc(date, festival.dayBoundaryMinutes, festival.timezone).getTime(),
    end: zonedToUtc(addDays(date, 1), festival.dayBoundaryMinutes, festival.timezone).getTime(),
  };
}

/** The festival day `now` falls in, or null outside the festival. */
export function festivalDayAt(festival: Festival, now: number): string | null {
  for (const day of festival.days) {
    const { start, end } = festivalDayBounds(festival, day.date);
    if (now >= start && now < end) return day.date;
  }
  return null;
}

/** Sessions happening at `now`. All-day sessions count while their festival day is on. */
export function sessionsOnAt(
  festival: Festival,
  sessions: readonly Session[],
  ends: Map<string, SessionEnd>,
  now: number,
): Session[] {
  const today = festivalDayAt(festival, now);
  return sessions.filter((s) => {
    if (s.status === 'cancelled') return false;
    if (!s.startsAt) return s.day === today;
    const end = ends.get(s.id);
    return Date.parse(s.startsAt) <= now && end !== undefined && now < Date.parse(end.endsAt);
  });
}

/** The next start time after `now` today, and every session starting then. */
export function sessionsUpNext(
  festival: Festival,
  sessions: readonly Session[],
  now: number,
): Session[] {
  const today = festivalDayAt(festival, now);
  const upcoming = sessions
    .filter((s) => s.day === today && s.startsAt && Date.parse(s.startsAt) > now)
    .filter((s) => s.status !== 'cancelled')
    .sort((a, b) => a.startsAt!.localeCompare(b.startsAt!));
  const first = upcoming[0]?.startsAt;
  return first ? upcoming.filter((s) => s.startsAt === first) : [];
}

export interface LineupEntry {
  key: string;
  title: string;
  kind: SessionKind;
  /** Every session with this title, in time order (e.g. a workshop that runs each day). */
  sessions: Session[];
}

/** One entry per act or workshop, A–Z, ignoring a leading "The". */
export function buildLineup(sessions: readonly Session[]): LineupEntry[] {
  const entries = new Map<string, LineupEntry>();
  for (const s of sessions) {
    const key = `${s.kind}|${s.title.toLowerCase()}`;
    const entry = entries.get(key) ?? { key, title: s.title, kind: s.kind, sessions: [] };
    entry.sessions.push(s);
    entries.set(key, entry);
  }
  const sortKey = (title: string) => title.replace(/^the\s+/i, '').toLowerCase();
  const byTime = (a: Session, b: Session) =>
    a.day.localeCompare(b.day) || (a.startsAt ?? '').localeCompare(b.startsAt ?? '');
  return [...entries.values()]
    .map((e) => ({ ...e, sessions: e.sessions.sort(byTime) }))
    .sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title), 'en', { numeric: true }));
}
