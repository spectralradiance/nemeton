import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CsvImportError, importFestivalCsv, type CsvImportOptions } from './csv';

const opts: CsvImportOptions = {
  festivalName: 'Test Fest',
  timezone: 'America/Los_Angeles',
  startDate: '2026-06-19', // a Friday
};
const HEADER = 'title/name,time,location,bandcamp,instagram,type,workshop facilitator';
const run = (...rows: string[]) => importFestivalCsv([HEADER, ...rows].join('\n'), opts);
const startOf = (r: ReturnType<typeof run>, title: string) =>
  r.snapshot.sessions.find((s) => s.title === title)?.startsAt;

describe('importFestivalCsv', () => {
  it('reads evening sets as PM and rolls late sets past midnight in running order', () => {
    const r = run(
      'Opener,Friday 2:00,Fireside,,,music,',
      'Late,Friday 11:00,Stage 1,,,music,',
      'Midnight,Friday 12:00,Stage 1,,,music,',
      'Very Late,Friday 1:00,Stage 2,,,music,',
    );
    // PDT is UTC-7.
    expect(startOf(r, 'Opener')).toBe('2026-06-19T21:00:00.000Z');
    expect(startOf(r, 'Late')).toBe('2026-06-20T06:00:00.000Z');
    expect(startOf(r, 'Midnight')).toBe('2026-06-20T07:00:00.000Z');
    expect(startOf(r, 'Very Late')).toBe('2026-06-20T08:00:00.000Z');
    // After-midnight sets still belong to the Friday festival day.
    expect(r.snapshot.sessions.every((s) => s.day === '2026-06-19')).toBe(true);
  });

  it('orders each type separately, so morning workshops stay AM', () => {
    const r = run(
      'Set,Saturday 3:00,Stage 1,,,music,',
      'Yoga,Saturday 9:00,Meadow,,,workshop,A',
      'Talk,Saturday 12:30,Stage 2,,,workshop,B',
      'Craft,Saturday 2:00,CommShare,,,workshop,C',
    );
    expect(startOf(r, 'Yoga')).toBe('2026-06-20T16:00:00.000Z'); // 09:00
    expect(startOf(r, 'Talk')).toBe('2026-06-20T19:30:00.000Z'); // 12:30
    expect(startOf(r, 'Craft')).toBe('2026-06-20T21:00:00.000Z'); // 14:00
  });

  it('treats "Ongoing" as an all-day session', () => {
    const r = run('Drop-in (drop-in),Sunday Ongoing,Meadow,,,workshop,A & B');
    const s = r.snapshot.sessions[0]!;
    expect(s).toMatchObject({
      startsAt: null,
      day: '2026-06-21',
      tags: ['drop-in'],
      people: ['A', 'B'],
    });
    expect(s.id).toBe('drop-in-drop-in-sun');
  });

  it('pulls (ritual) out as the session kind', () => {
    const s = run('Blood of the Earth (ritual),Saturday 7:30,Fireside,,,music,').snapshot
      .sessions[0]!;
    expect(s).toMatchObject({ kind: 'ritual', title: 'Blood of the Earth', tags: [] });
  });

  it('recovers vendor rows that are missing a column, with a warning', () => {
    const r = run(
      'Deep Sea Ceramics,,,,vendor,',
      'Corviid,,,,vendor,',
      'Set,Friday 3:00,Stage 1,,,music,',
    );
    expect(r.snapshot.vendors.map((v) => v.id)).toEqual(['deep-sea-ceramics', 'corviid']);
    expect(r.warnings).toEqual([
      '2 vendor rows are missing a column (lines 2, 3); read as vendors',
    ]);
  });

  it('finds columns by header name, in any order', () => {
    const r = importFestivalCsv(
      ['type,origin,title/name,location,time', 'music,Oregon,Gethen,Stage 2,Friday 3:00'].join(
        '\n',
      ),
      opts,
    );
    expect(r.snapshot.sessions[0]).toMatchObject({ title: 'Gethen', origin: 'Oregon' });
    expect(() => importFestivalCsv('title/name,time\nA,Friday 3:00', opts)).toThrow(
      /missing column\(s\) "location", "type"/,
    );
  });

  it('types links by their URL and expands bare handles by column', () => {
    const r = importFestivalCsv(
      [
        'title/name,time,location,type,bandcamp,instagram,website',
        'A,Friday 3:00,Meadow,music,a.bandcamp.com,@one two,https://www.facebook.com/a https://youtu.be/x https://a.example',
      ].join('\n'),
      opts,
    );
    expect(r.snapshot.sessions[0]!.links).toEqual([
      { kind: 'bandcamp', url: 'https://a.bandcamp.com/' },
      { kind: 'instagram', url: 'https://www.instagram.com/one/' },
      { kind: 'instagram', url: 'https://www.instagram.com/two/' },
      { kind: 'facebook', url: 'https://www.facebook.com/a' },
      { kind: 'youtube', url: 'https://youtu.be/x' },
      { kind: 'website', url: 'https://a.example/' },
    ]);
  });

  it('keeps paragraph breaks in descriptions but joins wrapped lines', () => {
    const r = importFestivalCsv(
      [
        'title/name,time,location,type,description,photo',
        'A,Friday 3:00,Meadow,workshop,"First line\r\nwraps here.\r\n\r\n\r\nSecond paragraph.",not a url',
      ].join('\n'),
      opts,
    );
    const s = r.snapshot.sessions[0]!;
    expect(s.description).toBe('First line wraps here.\n\nSecond paragraph.');
    expect(s.photo).toBeUndefined();
    expect(r.warnings).toEqual(['line 2: ignored unreadable photo "not a url"']);
  });

  it('refuses misaligned non-vendor rows instead of guessing', () => {
    expect(() => run('Band,Friday 3:00,Stage 1,,music,')).toThrow(CsvImportError);
  });

  it('reads a small hour after a later one as early morning, but not past the day boundary', () => {
    const r = run('A,Friday 5:00,Stage 1,,,music,', 'B,Friday 4:00,Stage 1,,,music,');
    expect(startOf(r, 'B')).toBe('2026-06-20T11:00:00.000Z'); // 04:00 Saturday, still Friday's festival day
    expect(() =>
      run(
        'A,Friday 2:00,Stage 1,,,music,',
        'B,Friday 11:00,Stage 1,,,music,',
        'C,Friday 10:00,Stage 1,,,music,',
      ),
    ).toThrow(/comes before the previous/);
  });

  it('sorts numbered stages first', () => {
    const r = run(
      'A,Friday 2:00,Fireside,,,music,',
      'B,Friday 3:00,Stage 2,,,music,',
      'C,Friday 4:00,Stage 1,,,music,',
    );
    expect(r.snapshot.stages.map((s) => s.name)).toEqual(['Stage 1', 'Stage 2', 'Fireside']);
  });

  it('imports the Cascadian Midsummer 2026 sheet', () => {
    const csv = readFileSync(
      new URL('../../../../data/raw/cascadian-midsummer-2026.csv', import.meta.url),
      'utf8',
    );
    const { snapshot, warnings } = importFestivalCsv(csv, opts);
    expect(snapshot.sessions).toHaveLength(53);
    expect(snapshot.vendors).toHaveLength(19);
    expect(snapshot.festival.days.map((d) => d.label)).toEqual(['Friday', 'Saturday', 'Sunday']);
    expect(snapshot.sessions.find((s) => s.id === 'fosphene-sun')?.title).toBe('Føsphene');
    expect(warnings).toEqual([
      'line 13: name "Cascadian Midsummer with Cascadian Animism..." looks truncated',
    ]);
    // Every workshop has a speaker card; every act with a band card has a bio and photo.
    const workshops = snapshot.sessions.filter((s) => s.kind === 'workshop');
    expect(workshops.every((s) => s.description && s.bio && s.photo)).toBe(true);
    expect(snapshot.sessions.filter((s) => s.kind === 'music' && s.bio)).toHaveLength(31);
  });
});
