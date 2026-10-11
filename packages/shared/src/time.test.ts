import { describe, expect, it } from 'vitest';
import { addDays, zonedToUtc } from './time';

describe('zonedToUtc', () => {
  it('converts summer and winter wall-clock times', () => {
    expect(zonedToUtc('2026-06-19', 14 * 60, 'America/Los_Angeles').toISOString()).toBe(
      '2026-06-19T21:00:00.000Z',
    );
    expect(zonedToUtc('2026-12-05', 14 * 60, 'America/Los_Angeles').toISOString()).toBe(
      '2026-12-05T22:00:00.000Z',
    );
  });

  it('handles minutes past midnight across a DST change', () => {
    // US clocks fall back at 02:00 on 2026-11-01; 25:30 on Oct 31 is 01:30 PDT (the first one).
    expect(zonedToUtc('2026-10-31', 25 * 60 + 30, 'America/Los_Angeles').toISOString()).toBe(
      '2026-11-01T08:30:00.000Z',
    );
    // 03:30 on Nov 1 is after the change, so PST.
    expect(zonedToUtc('2026-10-31', 27 * 60 + 30, 'America/Los_Angeles').toISOString()).toBe(
      '2026-11-01T11:30:00.000Z',
    );
  });
});

describe('addDays', () => {
  it('crosses month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-06-30', 2)).toBe('2026-07-02');
  });
});
