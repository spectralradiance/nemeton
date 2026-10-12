import { describe, expect, it } from 'vitest';
import { ItineraryOp, findClashes, hlcTime, tickHlc } from './itinerary';
import type { Session } from './schema';
import { estimateEnds } from './schedule';

describe('tickHlc', () => {
  it('is strictly increasing and sorts as a string', () => {
    let last: string | null = null;
    const seen: string[] = [];
    for (let i = 0; i < 50; i++) {
      const next = tickHlc(last, 'dev1', 1_000_000 + Math.floor(i / 10)); // many per millisecond
      if (last) expect(next > last).toBe(true);
      seen.push(next);
      last = next;
    }
    expect([...seen].sort()).toEqual(seen);
  });

  it('never goes backwards when the device clock does', () => {
    const a = tickHlc(null, 'dev1', 5_000_000);
    const b = tickHlc(a, 'dev1', 4_000_000); // clock jumped back an hour-ish
    expect(b > a).toBe(true);
    expect(hlcTime(b)).toBe(5_000_000);
  });

  it('orders by time before node id', () => {
    const early = tickHlc(null, 'zzz', 1_000);
    const late = tickHlc(null, 'aaa', 2_000);
    expect(late > early).toBe(true);
  });

  it('produces stamps the op schema accepts', () => {
    const op = {
      opId: crypto.randomUUID(),
      sessionId: 'hail-fri',
      state: 'added',
      hlc: tickHlc(null, crypto.randomUUID()),
    };
    expect(() => ItineraryOp.parse(op)).not.toThrow();
  });
});

describe('findClashes', () => {
  let n = 0;
  const session = (
    startsAt: string | null,
    stageId = 's1',
    status: Session['status'] = 'scheduled',
  ): Session => ({
    id: `x${n++}`,
    kind: 'music',
    title: 'Act',
    tags: [],
    day: '2026-06-19',
    startsAt,
    endsAt: null,
    stageId,
    people: [],
    links: [],
    status,
  });

  it('finds overlaps across stages, but not back-to-back or all-day sessions', () => {
    const a = session('2026-06-20T03:00:00.000Z', 's1'); // ends +45m (music default)
    const b = session('2026-06-20T03:30:00.000Z', 's2'); // overlaps a
    const c = session('2026-06-20T04:15:00.000Z', 's2'); // b ends 04:15 → touches, no clash
    const allDay = session(null, 's3');
    const clashes = findClashes([a, b, c, allDay], estimateEnds([a, b, c, allDay]));
    expect(clashes.get(a.id)?.map((s) => s.id)).toEqual([b.id]);
    expect(clashes.get(b.id)?.map((s) => s.id)).toEqual([a.id]);
    expect(clashes.has(c.id)).toBe(false);
    expect(clashes.has(allDay.id)).toBe(false);
  });

  it('ignores cancelled sessions', () => {
    const a = session('2026-06-20T03:00:00.000Z', 's1');
    const b = session('2026-06-20T03:10:00.000Z', 's2', 'cancelled');
    expect(findClashes([a, b], estimateEnds([a, b])).size).toBe(0);
  });
});
