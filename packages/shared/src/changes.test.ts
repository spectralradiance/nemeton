import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyChanges, diffSnapshots } from './changes';
import { Snapshot } from './schema';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const byId = (snap: Snapshot, id: string) => snap.sessions.find((s) => s.id === id)!;

describe('diffSnapshots + applyChanges', () => {
  it('finds nothing to change between identical snapshots, whatever the key order', () => {
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverseKeys(x)]),
            )
          : v;
    expect(diffSnapshots(seed, reverseKeys(seed) as Snapshot)).toEqual([]);
  });

  it('round-trips: applying the diff of a→b to a gives b', () => {
    const after: Snapshot = {
      ...seed,
      festival: { ...seed.festival, name: 'Renamed' },
      stages: [...seed.stages, { id: 'grove', name: 'Grove', order: 5 }],
      sessions: [
        ...seed.sessions
          .filter((s) => s.id !== 'gethen-fri')
          .map((s) =>
            s.id === 'hail-fri' ? { ...s, status: 'delayed' as const, stageId: 'grove' } : s,
          ),
      ],
      vendors: seed.vendors.slice(1),
    };
    const changes = diffSnapshots(seed, after);
    expect(changes).toHaveLength(5); // festival, stage, session, 2 deletes
    expect(applyChanges(seed, changes, 7)).toEqual({ ...after, seq: 7 });
  });

  it('orders changes so references stay valid: new stage before the session moved onto it', () => {
    const after: Snapshot = {
      ...seed,
      stages: [{ id: 'grove', name: 'Grove', order: 9 }, ...seed.stages],
      sessions: seed.sessions.map((s) => (s.id === 'hail-fri' ? { ...s, stageId: 'grove' } : s)),
    };
    const kinds = diffSnapshots(seed, after).map((c) => c.entity);
    expect(kinds).toEqual(['stage', 'session']);
  });

  it('deletes sessions before the stage they were on', () => {
    const after: Snapshot = {
      ...seed,
      stages: seed.stages.filter((s) => s.id !== 'commshare'),
      sessions: seed.sessions.filter((s) => s.stageId !== 'commshare'),
    };
    const changes = diffSnapshots(seed, after);
    expect(changes.at(-1)).toEqual({ op: 'delete', entity: 'stage', id: 'commshare' });
    expect(() => applyChanges(seed, changes)).not.toThrow();
  });
});

describe('applyChanges validation', () => {
  it('rejects a session pointing at a stage that does not exist', () => {
    const hail = byId(seed, 'hail-fri');
    expect(() =>
      applyChanges(seed, [
        { op: 'upsert', entity: 'session', id: hail.id, data: { ...hail, stageId: 'nowhere' } },
      ]),
    ).toThrow(/unknown stage/);
  });

  it('rejects an upsert whose data id differs from the change id', () => {
    const hail = byId(seed, 'hail-fri');
    expect(() =>
      applyChanges(seed, [{ op: 'upsert', entity: 'session', id: 'other', data: hail }]),
    ).toThrow(/doesn't match/);
  });

  it('rejects malformed data', () => {
    expect(() =>
      applyChanges(seed, [{ op: 'upsert', entity: 'vendor', id: 'x', data: { id: 'x' } }]),
    ).toThrow();
  });

  it('never deletes the festival', () => {
    expect(() =>
      applyChanges(seed, [{ op: 'delete', entity: 'festival', id: 'festival' }]),
    ).toThrow();
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(seed);
    applyChanges(seed, [{ op: 'delete', entity: 'session', id: 'hail-fri' }]);
    expect(JSON.stringify(seed)).toBe(before);
  });
});
