import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Snapshot, applyChanges } from '@nemeton/shared';
import { describeChanges } from './describe';
import { UsageError, delaySession, findSession, moveSession, parseDuration } from './edits';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const get = (id: string) => seed.sessions.find((s) => s.id === id)!;

describe('parseDuration', () => {
  it.each([
    ['20m', 20],
    ['20', 20],
    ['1h', 60],
    ['1h30m', 90],
    ['-10m', -10],
    ['+5m', 5],
  ])('%s is %i minutes', (text, minutes) => {
    expect(parseDuration(text)).toBe(minutes * 60_000);
  });

  it.each(['', 'soon', '1d', '0m', 'h'])('rejects %j', (text) => {
    expect(() => parseDuration(text)).toThrow(UsageError);
  });
});

describe('findSession', () => {
  it('matches exact ids, then unambiguous title fragments ignoring accents', () => {
    expect(findSession(seed, 'hail-fri').title).toBe('Hail');
    expect(findSession(seed, 'fosphene').id).toBe('fosphene-sun');
  });

  it('lists the candidates when a fragment is ambiguous', () => {
    expect(() => findSession(seed, 'holy death')).toThrow(/several sessions[\s\S]*-sat/);
  });
});

describe('delaySession', () => {
  it('shifts the start, marks it delayed and explains why by default', () => {
    const hail = delaySession(get('hail-fri'), seed, 20 * 60_000);
    expect(hail.startsAt).toBe('2026-06-20T03:50:00.000Z'); // 8:50 PM PDT
    expect(hail).toMatchObject({ status: 'delayed', note: 'Delayed 20 min, now Fri 8:50 PM' });
  });

  it('calls an earlier start a move, and keeps a custom note', () => {
    const hail = delaySession(get('hail-fri'), seed, -15 * 60_000, 'Starting early!');
    expect(hail).toMatchObject({ status: 'moved', note: 'Starting early!' });
  });

  it('refuses all-day sessions', () => {
    expect(() =>
      delaySession(get('holy-death-animal-slaughter-workshop-drop-in-sat'), seed, 60_000),
    ).toThrow(/all day/);
  });
});

describe('moveSession', () => {
  it('puts small-hours times on the night after the festival day', () => {
    const fauna = moveSession(get('fauna-sun'), seed, { stage: 'Stage 2', at: '00:30' });
    expect(fauna).toMatchObject({ day: '2026-06-21', stageId: 'stage-2', status: 'moved' });
    expect(fauna.startsAt).toBe('2026-06-22T07:30:00.000Z'); // Mon 12:30 AM PDT
  });

  it('keeps the local time when only the day changes', () => {
    const gethen = moveSession(get('gethen-fri'), seed, { day: 'sat' });
    expect(gethen).toMatchObject({ day: '2026-06-20', startsAt: '2026-06-20T22:00:00.000Z' });
  });

  it('produces a session the schedule accepts', () => {
    const fauna = moveSession(get('fauna-sun'), seed, { stage: 'meadow', at: '22:15' });
    expect(() =>
      applyChanges(seed, [{ op: 'upsert', entity: 'session', id: fauna.id, data: fauna }]),
    ).not.toThrow();
  });

  it('explains bad input', () => {
    expect(() => moveSession(get('fauna-sun'), seed, {})).toThrow(/--stage, --at/);
    expect(() => moveSession(get('fauna-sun'), seed, { stage: 'nowhere' })).toThrow(/Stages:/);
    expect(() => moveSession(get('fauna-sun'), seed, { at: '25:00' })).toThrow(/24-hour/);
    expect(() => moveSession(get('fauna-sun'), seed, { day: 'monday' })).toThrow(/Days:/);
  });
});

describe('describeChanges', () => {
  it('shows times and stages the way people read them', () => {
    const fauna = moveSession(get('fauna-sun'), seed, { stage: 'Stage 2', at: '00:30' });
    const [line] = describeChanges(seed, [
      { op: 'upsert', entity: 'session', id: fauna.id, data: fauna },
    ]);
    expect(line).toContain('start Sun 11:00 PM → Mon 12:30 AM');
    expect(line).toContain('stage Stage 1 → Stage 2');
  });

  it('marks additions and removals', () => {
    expect(describeChanges(seed, [{ op: 'delete', entity: 'vendor', id: 'corviid' }])).toEqual([
      '- vendor corviid "Corviid"',
    ]);
  });
});
