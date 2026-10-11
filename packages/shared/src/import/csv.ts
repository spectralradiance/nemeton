import { parse } from 'csv-parse/sync';
import {
  Snapshot,
  type Link,
  type LinkKind,
  type Session,
  type SessionKind,
  type Stage,
  type Vendor,
} from '../schema';
import { slugify } from '../slug';
import { addDays, zonedToUtc } from '../time';

/**
 * Imports the organizer spreadsheet format. Columns are found by header name, in any order:
 *
 *   title/name, time, location, type                     (required)
 *   bandcamp, instagram, website                         (URLs or handles; several per cell, space-separated)
 *   workshop facilitator                                 ("A & B")
 *   photo, subtitle, origin, description, bio            (description/bio: paragraphs split by blank lines)
 *
 * A link's kind comes from its URL, so a Facebook page in the website column is still a facebook link.
 * The column only decides how a bare handle like "@someone" is expanded.
 *
 * `time` is "<Weekday> <h:mm>" on a 12-hour clock with no AM/PM, or "<Weekday> Ongoing".
 */
export interface CsvImportOptions {
  festivalName: string;
  timezone: string;
  /** Calendar date of the festival's first day. Weekday names in the CSV resolve on or after it. */
  startDate: string;
  /** When a festival day rolls over, in minutes after local midnight. Defaults to 06:00. */
  dayBoundaryMinutes?: number;
}

export interface ResolvedTime {
  title: string;
  day: string;
  raw: string;
  /** Minutes after local midnight of `day`; >= 1440 means after midnight. */
  minutes: number;
}

export interface CsvImportResult {
  snapshot: Snapshot;
  /** Problems in the source that were worked around and should be fixed upstream. */
  warnings: string[];
  /** How each clock time was read, for a human to check. */
  times: ResolvedTime[];
}

const COLUMNS = {
  name: 'title/name',
  time: 'time',
  location: 'location',
  type: 'type',
  bandcamp: 'bandcamp',
  instagram: 'instagram',
  website: 'website',
  people: 'workshop facilitator',
  photo: 'photo',
  subtitle: 'subtitle',
  origin: 'origin',
  description: 'description',
  bio: 'bio',
} as const;
type Column = keyof typeof COLUMNS;
const REQUIRED: Column[] = ['name', 'time', 'location', 'type'];
const LINK_COLUMNS = ['bandcamp', 'instagram', 'website'] as const satisfies readonly Column[];
const LINK_HOSTS: Array<[RegExp, LinkKind]> = [
  [/(^|\.)bandcamp\.com$/, 'bandcamp'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
];

const TYPES = ['music', 'workshop', 'vendor'] as const;
type RowType = (typeof TYPES)[number];
const isRowType = (v: string): v is RowType => (TYPES as readonly string[]).includes(v);

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const TIME_RE = /^([a-z]+)\s+(?:(\d{1,2}):(\d{2})|(ongoing))$/i;
const HALF_DAY = 12 * 60;

export class CsvImportError extends Error {}

export function importFestivalCsv(csvText: string, opts: CsvImportOptions): CsvImportResult {
  const dayBoundary = opts.dayBoundaryMinutes ?? 6 * 60;
  const warnings: string[] = [];
  const errors: string[] = [];

  const rows: string[][] = parse(csvText, {
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  const header = (rows[0] ?? []).map((h) => h.toLowerCase());
  const columnIndex = new Map<Column, number>();
  for (const [col, name] of Object.entries(COLUMNS) as [Column, string][]) {
    const i = header.indexOf(name);
    if (i !== -1) columnIndex.set(col, i);
  }
  const missing = REQUIRED.filter((c) => !columnIndex.has(c)).map((c) => `"${COLUMNS[c]}"`);
  if (missing.length) throw new CsvImportError(`CSV is missing column(s) ${missing.join(', ')}`);
  const known = new Set<string>(Object.values(COLUMNS));
  const unknown = header.filter((h) => h && !known.has(h));
  if (unknown.length) warnings.push(`ignored unknown column(s): ${unknown.join(', ')}`);

  const vendors: Vendor[] = [];
  const stageFirstSeen = new Map<string, number>();
  const dayDates = new Map<string, string>(); // weekday label -> ISO date
  const lastMinutes = new Map<string, number>(); // `${day}|${type}` -> last resolved time
  const times: ResolvedTime[] = [];
  const pending: Array<Omit<Session, 'startsAt' | 'endsAt'> & { minutes: number | null }> = [];
  const shortVendorLines: number[] = [];

  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const cell = (col: Column) => {
      const idx = columnIndex.get(col);
      return idx === undefined ? '' : (cells[idx] ?? '');
    };
    const name = cell('name');
    if (!name) return;

    let type = cell('type').toLowerCase();
    if (!isRowType(type)) {
      const found = cells.findIndex((c, n) => n > 0 && isRowType(c.toLowerCase()));
      if (found === -1) {
        errors.push(`line ${line} (${name}): no recognizable type (expected ${TYPES.join('/')})`);
        return;
      }
      type = cells[found]!.toLowerCase();
      if (type !== 'vendor') {
        errors.push(
          `line ${line} (${name}): type "${type}" is in column ${found + 1}, not ${columnIndex.get('type')! + 1}; columns are misaligned`,
        );
        return;
      }
      // Vendors only use the name, so a row that's short a column is still usable.
      shortVendorLines.push(line);
    }
    if (name.endsWith('...') || name.endsWith('…')) {
      warnings.push(`line ${line}: name "${name}" looks truncated`);
    }

    if (type === 'vendor') {
      const links = shortVendorLines.at(-1) === line ? [] : parseLinks(cell, line, warnings);
      vendors.push({ id: slugify(name), name, links });
      return;
    }

    const match = TIME_RE.exec(cell('time'));
    if (!match) {
      errors.push(`line ${line} (${name}): can't read time "${cell('time')}"`);
      return;
    }
    const weekday = match[1]!.toLowerCase();
    const label = weekday[0]!.toUpperCase() + weekday.slice(1);
    if (!WEEKDAYS.includes(weekday)) {
      errors.push(`line ${line} (${name}): "${match[1]}" is not a weekday`);
      return;
    }
    if (!dayDates.has(label))
      dayDates.set(label, nextWeekday(opts.startDate, WEEKDAYS.indexOf(weekday)));
    const day = dayDates.get(label)!;

    let minutes: number | null = null;
    if (!match[4]) {
      const h = Number(match[2]);
      const m = Number(match[3]);
      if (h < 1 || h > 12 || m > 59) {
        errors.push(`line ${line} (${name}): "${cell('time')}" isn't a 12-hour clock time`);
        return;
      }
      // No AM/PM in the source. Rows of one type on one day are listed in running order, so take the
      // earliest reading that is after the day boundary and not before the previous row.
      const key = `${day}|${type}`;
      const floor = Math.max(dayBoundary, lastMinutes.get(key) ?? 0);
      const base = (h % 12) * 60 + m;
      const pick = [base, base + HALF_DAY, base + 2 * HALF_DAY, base + 3 * HALF_DAY].find(
        (t) => t >= floor,
      );
      if (pick === undefined || pick >= 24 * 60 + dayBoundary) {
        errors.push(
          `line ${line} (${name}): "${cell('time')}" comes before the previous ${type} row on ${label}`,
        );
        return;
      }
      minutes = pick;
      lastMinutes.set(key, pick);
      times.push({ title: name, day: label, raw: cell('time'), minutes });
    }

    const location = cell('location');
    if (!location) {
      errors.push(`line ${line} (${name}): no location`);
      return;
    }
    if (!stageFirstSeen.has(location)) stageFirstSeen.set(location, line);

    const { title, qualifiers } = splitQualifiers(name);
    const kind: SessionKind =
      type === 'workshop' ? 'workshop' : qualifiers.includes('ritual') ? 'ritual' : 'music';
    const tags = qualifiers.filter((q) => q !== 'ritual');

    pending.push({
      id: `${slugify([title, ...tags].join(' '))}-${label.slice(0, 3).toLowerCase()}`,
      kind,
      title,
      ...optional('subtitle', cell('subtitle')),
      tags,
      day,
      stageId: slugify(location),
      people: splitPeople(cell('people')),
      ...optional('origin', cell('origin')),
      ...optional('description', paragraphs(cell('description'))),
      ...optional('bio', paragraphs(cell('bio'))),
      ...optional('photo', parseUrl(cell('photo'), 'photo', line, warnings)),
      links: parseLinks(cell, line, warnings),
      status: 'scheduled',
      minutes,
    });
  });

  if (errors.length) throw new CsvImportError(`CSV import failed:\n  ${errors.join('\n  ')}`);
  if (shortVendorLines.length) {
    warnings.unshift(
      `${shortVendorLines.length} vendor rows are missing a column (lines ${shortVendorLines.join(', ')}); read as vendors`,
    );
  }

  const sessions: Session[] = pending.map(({ minutes, ...s }) => ({
    ...s,
    startsAt: minutes === null ? null : zonedToUtc(s.day, minutes, opts.timezone).toISOString(),
    endsAt: null,
  }));

  const stages: Stage[] = [...stageFirstSeen.keys()]
    .sort((a, b) => stageRank(a) - stageRank(b) || stageFirstSeen.get(a)! - stageFirstSeen.get(b)!)
    .map((name, order) => ({ id: slugify(name), name, order }));

  const days = [...dayDates.entries()]
    .map(([label, date]) => ({ label, date }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const result = Snapshot.safeParse({
    seq: 0,
    festival: {
      name: opts.festivalName,
      timezone: opts.timezone,
      dayBoundaryMinutes: dayBoundary,
      days,
    },
    stages,
    sessions,
    vendors,
  });
  if (!result.success) {
    throw new CsvImportError(
      `CSV import produced invalid data:\n  ${result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('\n  ')}`,
    );
  }
  return { snapshot: result.data, warnings, times };
}

/** Spreads `{ [key]: value }` only when there is a value, so optional fields stay absent. */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value ? ({ [key]: value } as { [P in K]: string }) : {};
}

/** "Stage 1", "Stage 2"… sort first, in number order; other locations keep their order of appearance. */
function stageRank(name: string): number {
  const m = /^stage\s+(\d+)$/i.exec(name);
  return m ? Number(m[1]) - 1000 : 0;
}

function nextWeekday(startDate: string, weekday: number): string {
  for (let i = 0; i < 7; i++) {
    const date = addDays(startDate, i);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === weekday) return date;
  }
  throw new Error('unreachable');
}

/** "Blood of the Earth (ritual)" -> { title: "Blood of the Earth", qualifiers: ["ritual"] } */
function splitQualifiers(name: string): { title: string; qualifiers: string[] } {
  const qualifiers: string[] = [];
  let title = name;
  for (let m; (m = /\s*\(([^()]+)\)\s*$/.exec(title));) {
    qualifiers.unshift(m[1]!.trim().toLowerCase());
    title = title.slice(0, m.index);
  }
  return { title, qualifiers };
}

function splitPeople(text: string): string[] {
  return text
    .split(/\s*&\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Normalizes line endings and paragraph breaks; spreadsheets are inconsistent about both. */
function paragraphs(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function parseUrl(value: string, what: string, line: number, warnings: string[]) {
  if (!value) return undefined;
  try {
    return new URL(value).toString();
  } catch {
    warnings.push(`line ${line}: ignored unreadable ${what} "${value}"`);
    return undefined;
  }
}

function parseLinks(cell: (col: Column) => string, line: number, warnings: string[]): Link[] {
  const links: Link[] = [];
  for (const column of LINK_COLUMNS) {
    for (const value of cell(column).split(/\s+/).filter(Boolean)) {
      const url = parseUrl(toUrl(column, value), `${column} link`, line, warnings);
      if (!url) continue;
      const host = new URL(url).hostname.toLowerCase();
      const kind = LINK_HOSTS.find(([re]) => re.test(host))?.[1] ?? 'website';
      if (!links.some((l) => l.url === url)) links.push({ kind, url });
    }
  }
  return links;
}

/** Accepts full URLs, or bare handles/domains the way people type them into a spreadsheet. */
function toUrl(column: (typeof LINK_COLUMNS)[number], value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  if (column === 'instagram') return `https://www.instagram.com/${value.replace(/^@/, '')}/`;
  return `https://${value}`;
}
