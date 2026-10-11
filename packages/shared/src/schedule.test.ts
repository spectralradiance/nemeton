import { describe, expect, it } from 'vitest';
import type { Festival, Session } from './schema';
import { buildLineup, estimateEnds, festivalDayAt, sessionsOnAt, sessionsUpNext } from './schedule';

const festival: Festival = {
  name: 'Test',
  timezone: 'America/Los_Angeles',
  dayBoundaryMinutes: 360,
  days: [
    { date: '2026-06-19', label: 'Friday' },
    { date: '2026-06-20', label: 'Saturday' },
  ],
};

let n = 0;
function session(over: Partial<Session>): Session {
  return {
    id: `s${n++}`,
    kind: 'music',
    title: 'Act',
    tags: [],
    day: '2026-06-19',
    startsAt: null,
    endsAt: null,
    stageId: 'stage-1',
    people: [],
    links: [],
    status: 'scheduled',
    ...over,
  };
}
// Friday 2026-06-19, PDT (UTC-7): 14:00 local = 21:00Z.
const at = (hhmm: string, date = '2026-06-19') => `${date}T${hhmm}:00.000Z`;

describe('estimateEnds', () => {
  it('ends at the next start on the same stage, capped at the default length', () => {
    const a = session({ startsAt: at('21:00') });
    const b = session({ startsAt: at('21:30') }); // 30 min later: shorter than 45
    const c = session({ startsAt: at('23:00') }); // last on stage: default 45
    const other = session({ startsAt: at('21:10'), stageId: 'stage-2' });
    const ends = estimateEnds([c, a, other, b]);
    expect(ends.get(a.id)).toEqual({ endsAt: at('21:30'), estimated: true });
    expect(ends.get(b.id)).toEqual({ endsAt: at('22:15'), estimated: true });
    expect(ends.get(c.id)).toEqual({ endsAt: at('23:45'), estimated: true });
    expect(ends.get(other.id)?.endsAt).toBe(at('21:55'));
  });

  it('keeps published ends and skips all-day sessions', () => {
    const a = session({ startsAt: at('21:00'), endsAt: at('22:30') });
    const allDay = session({});
    const ends = estimateEnds([a, allDay]);
    expect(ends.get(a.id)).toEqual({ endsAt: at('22:30'), estimated: false });
    expect(ends.has(allDay.id)).toBe(false);
  });
});

describe('festivalDayAt', () => {
  it('keeps the small hours on the previous festival day', () => {
    // 01:30 Saturday local is still Friday's festival day (boundary 06:00).
    expect(festivalDayAt(festival, Date.parse('2026-06-20T08:30:00Z'))).toBe('2026-06-19');
    expect(festivalDayAt(festival, Date.parse('2026-06-20T13:30:00Z'))).toBe('2026-06-20');
    expect(festivalDayAt(festival, Date.parse('2026-06-25T20:00:00Z'))).toBeNull();
  });
});

describe('sessionsOnAt / sessionsUpNext', () => {
  const a = session({ startsAt: at('21:00') });
  const b = session({ startsAt: at('22:00'), stageId: 'stage-2' });
  const c = session({ startsAt: at('22:00') });
  const allDay = session({});
  const cancelled = session({ startsAt: at('21:00'), stageId: 'meadow', status: 'cancelled' });
  const all = [a, b, c, allDay, cancelled];
  const ends = estimateEnds(all);
  const now = Date.parse(at('21:20'));

  it('lists what is on, including all-day sessions, excluding cancelled ones', () => {
    expect(sessionsOnAt(festival, all, ends, now).map((s) => s.id)).toEqual([a.id, allDay.id]);
  });

  it('lists everything starting at the next start time', () => {
    expect(
      sessionsUpNext(festival, all, now)
        .map((s) => s.id)
        .sort(),
    ).toEqual([b.id, c.id].sort());
  });
});

describe('buildLineup', () => {
  it('groups repeats by title and sorts A–Z ignoring "The" and numbers naturally', () => {
    const lineup = buildLineup([
      session({ title: 'The Zeal', day: '2026-06-20' }),
      session({ title: 'Drop-in', kind: 'workshop', day: '2026-06-20' }),
      session({ title: 'Drop-in', kind: 'workshop', day: '2026-06-19' }),
      session({ title: '40 Watt Sun' }),
      session({ title: '5 Pines' }),
      session({ title: 'Apple' }),
    ]);
    expect(lineup.map((e) => e.title)).toEqual([
      '5 Pines',
      '40 Watt Sun',
      'Apple',
      'Drop-in',
      'The Zeal',
    ]);
    expect(lineup.find((e) => e.title === 'Drop-in')!.sessions.map((s) => s.day)).toEqual([
      '2026-06-19',
      '2026-06-20',
    ]);
  });
});
