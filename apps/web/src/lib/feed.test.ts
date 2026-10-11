import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Snapshot, type Session } from '@nemeton/shared';
import type { FeedItem } from '../data/db';
import { describeFeedItem } from './feed';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const hail = seed.sessions.find((s) => s.id === 'hail-fri')!;
const stageName = (id: string) => seed.stages.find((s) => s.id === id)?.name ?? id;
const item = (over: Partial<FeedItem>): FeedItem => ({
  seq: 1,
  at: '2026-06-19T20:00:00.000Z',
  sessionId: hail.id,
  op: 'upsert',
  ...over,
});
const describe_ = (over: Partial<FeedItem>) =>
  describeFeedItem(item(over), seed.festival, stageName);
const later: Session = {
  ...hail,
  status: 'delayed',
  startsAt: '2026-06-20T03:50:00.000Z',
  note: 'Generator trouble',
};

describe('describeFeedItem', () => {
  it('says what changed and where it is now and was', () => {
    expect(describe_({ before: hail, after: later })).toEqual({
      label: 'Delayed',
      tone: 'warn',
      title: 'Hail',
      now: 'Now Fri 8:50 PM · Stage 1',
      was: 'Was Fri 8:30 PM · Stage 1',
      note: 'Generator trouble',
    });
  });

  it('handles cancellations, reinstatements, additions and removals', () => {
    expect(describe_({ before: hail, after: { ...hail, status: 'cancelled' } }).label).toBe(
      'Cancelled',
    );
    expect(describe_({ before: later, after: hail }).label).toBe('Back on');
    expect(describe_({ after: hail, added: true }).label).toBe('Added');
    expect(describe_({ op: 'delete', before: hail })).toMatchObject({
      label: 'Removed',
      title: 'Hail',
      was: 'Was Fri 8:30 PM · Stage 1',
    });
  });

  it('describes downloaded history, which has no "before", from the status alone', () => {
    expect(describe_({ after: later })).toMatchObject({ label: 'Delayed', was: undefined });
  });

  it('calls a stage or time change without a status "Changed"', () => {
    expect(describe_({ before: hail, after: { ...hail, stageId: 'meadow' } })).toMatchObject({
      label: 'Changed',
      now: 'Now Fri 8:30 PM · Meadow',
    });
  });
});
