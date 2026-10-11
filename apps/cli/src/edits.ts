import { slugify, zonedToUtc, type Session, type Snapshot } from '@nemeton/shared';
import { formatWhen } from './describe';

// Pure session edits behind the delay/move/cancel commands, kept apart from argument parsing
// and I/O so the time arithmetic can be tested.

export class UsageError extends Error {}

/** Accent- and punctuation-insensitive (ø, æ… included), e.g. "Føsphene" → "fosphene". */
const fold = (s: string) => slugify(s);

/** By exact id, or by a piece of the title if only one session matches. */
export function findSession(snapshot: Snapshot, query: string): Session {
  const exact = snapshot.sessions.find((s) => s.id === query);
  if (exact) return exact;
  const matches = snapshot.sessions.filter((s) => fold(s.title).includes(fold(query)));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new UsageError(`No session matches "${query}".`);
  const show = (s: Session) =>
    `  ${s.id.padEnd(48)} ${s.title} (${formatWhen(snapshot.festival, s.startsAt)})`;
  throw new UsageError(`"${query}" matches several sessions:\n${matches.map(show).join('\n')}`);
}

/** "20m", "1h", "1h30m", "-10m", or bare minutes "20". Returns milliseconds. */
export function parseDuration(text: string | undefined): number {
  const m = /^([+-])?(?:(\d+)h)?(?:(\d+)m?)?$/.exec(text ?? '');
  if (!text || !m || (!m[2] && !m[3])) {
    throw new UsageError(`"${text ?? ''}" isn't a duration. Try 20m, 1h or 1h30m.`);
  }
  const minutes = Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  if (minutes === 0) throw new UsageError('A delay of 0 changes nothing.');
  return (m[1] === '-' ? -minutes : minutes) * 60_000;
}

export function delaySession(s: Session, snapshot: Snapshot, ms: number, note?: string): Session {
  if (!s.startsAt) throw new UsageError(`${s.id} runs all day; there's no start time to delay.`);
  const shift = (t: string | null) => (t ? new Date(Date.parse(t) + ms).toISOString() : null);
  const startsAt = shift(s.startsAt);
  return {
    ...s,
    startsAt,
    endsAt: shift(s.endsAt),
    status: ms > 0 ? 'delayed' : 'moved',
    note:
      note ??
      `${ms > 0 ? 'Delayed' : 'Brought forward'} ${Math.abs(ms / 60_000)} min, now ${formatWhen(snapshot.festival, startsAt)}`,
  };
}

export interface MoveOptions {
  /** Stage id or name. */
  stage?: string;
  /** Festival-local 24-hour time, "HH:MM". Small hours mean the night after the festival day. */
  at?: string;
  /** Festival day label ("Saturday", "sat") or ISO date. */
  day?: string;
  note?: string;
}

export function moveSession(s: Session, snapshot: Snapshot, opts: MoveOptions): Session {
  const { festival } = snapshot;
  if (!opts.stage && !opts.at && !opts.day) {
    throw new UsageError('Say where or when: --stage, --at and/or --day.');
  }
  const stage = opts.stage
    ? snapshot.stages.find((x) => x.id === opts.stage || fold(x.name) === fold(opts.stage!))
    : snapshot.stages.find((x) => x.id === s.stageId);
  if (!stage) {
    throw new UsageError(
      `No stage "${opts.stage}". Stages: ${snapshot.stages.map((x) => x.id).join(', ')}`,
    );
  }
  const day = opts.day
    ? festival.days.find((d) => d.date === opts.day || fold(d.label).startsWith(fold(opts.day!)))
    : festival.days.find((d) => d.date === s.day);
  if (!day) {
    throw new UsageError(
      `No festival day "${opts.day}". Days: ${festival.days.map((d) => d.label).join(', ')}`,
    );
  }

  let startsAt = s.startsAt;
  let endsAt = s.endsAt;
  if (opts.at || opts.day) {
    let minutes: number;
    if (opts.at) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(opts.at);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
        throw new UsageError(`"${opts.at}" isn't a time. Use 24-hour HH:MM, e.g. 21:30.`);
      }
      minutes = Number(m[1]) * 60 + Number(m[2]);
    } else if (s.startsAt) {
      // Same local time on a different day.
      const [h, m] = new Date(s.startsAt)
        .toLocaleTimeString('en-GB', {
          timeZone: festival.timezone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
        .split(':')
        .map(Number) as [number, number];
      minutes = h * 60 + m;
    } else {
      throw new UsageError(`${s.id} runs all day; give --at to set a time.`);
    }
    // Small hours belong to the night before: 01:00 on Friday's festival day is Saturday 1 AM.
    if (minutes < festival.dayBoundaryMinutes) minutes += 24 * 60;
    startsAt = zonedToUtc(day.date, minutes, festival.timezone).toISOString();
    if (s.startsAt && s.endsAt) {
      endsAt = new Date(
        Date.parse(startsAt) + Date.parse(s.endsAt) - Date.parse(s.startsAt),
      ).toISOString();
    }
  }
  return {
    ...s,
    day: day.date,
    stageId: stage.id,
    startsAt,
    endsAt,
    status: 'moved',
    note: opts.note ?? `Moved to ${stage.name}, ${formatWhen(festival, startsAt)}`,
  };
}
