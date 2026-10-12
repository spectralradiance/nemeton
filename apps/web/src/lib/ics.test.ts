import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Snapshot, estimateEnds } from '@nemeton/shared';
import { buildIcs } from './ics';

const seed = Snapshot.parse(
  JSON.parse(readFileSync(new URL('../../../../data/seed/festival.json', import.meta.url), 'utf8')),
);
const get = (id: string) => seed.sessions.find((s) => s.id === id)!;
const stageName = (id: string) => seed.stages.find((s) => s.id === id)?.name ?? id;
const ends = estimateEnds(seed.sessions);
const NOW = Date.parse('2026-06-01T00:00:00Z');

describe('buildIcs', () => {
  const ics = buildIcs(
    seed.festival,
    [
      get('hail-fri'),
      { ...get('fauna-sun'), status: 'cancelled', note: 'High winds; sorry, all' },
      get('holy-death-animal-slaughter-workshop-drop-in-sat'),
      get('finding-the-nexus-of-fantasy-metal-music-pantheism-and-environmentalism-sun'),
    ],
    ends,
    stageName,
    NOW,
  );
  const lines = ics.split('\r\n');

  it('is a calendar with one event per session, CRLF line endings', () => {
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(4);
  });

  it('uses UTC times with the estimated end, and a stable UID', () => {
    const start = lines.indexOf('UID:hail-fri@nemeton');
    expect(lines.slice(start, start + 6)).toEqual([
      'UID:hail-fri@nemeton',
      'DTSTAMP:20260601T000000Z',
      'DTSTART:20260620T033000Z', // Fri 8:30 PM PDT
      'DTEND:20260620T041500Z',
      'SUMMARY:Hail',
      'LOCATION:Stage 1',
    ]);
  });

  it('marks cancelled sessions and escapes text', () => {
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('DESCRIPTION:Cancelled. High winds\\; sorry\\, all');
  });

  it('writes all-day sessions as date-only events', () => {
    expect(ics).toContain('DTSTART;VALUE=DATE:20260620');
    expect(ics).toContain('DTEND;VALUE=DATE:20260621');
  });

  it('folds long lines at 75 octets', () => {
    for (const line of lines) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines.some((l) => l.startsWith(' '))).toBe(true); // the long workshop title was folded
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain(
      'SUMMARY:Finding the Nexus of Fantasy\\, Metal Music\\, Pantheism\\, and Environmentalism',
    );
  });
});
