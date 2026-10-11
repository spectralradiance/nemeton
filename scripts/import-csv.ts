/**
 * Converts an organizer CSV into the snapshot JSON the server serves.
 *
 *   npm run import:csv                       # Cascadian Midsummer 2026 with its defaults
 *   tsx scripts/import-csv.ts <file.csv> --out <file.json>
 *       [--name "…"] [--tz America/Los_Angeles] [--start 2026-06-19]
 *
 * --start re-bases the weekday names onto a different weekend, which is handy for demoing
 * "on now" against real data.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { CsvImportError, importFestivalCsv } from '@nemeton/shared/import';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    name: { type: 'string', default: 'Cascadian Midsummer 2026' },
    tz: { type: 'string', default: 'America/Los_Angeles' },
    start: { type: 'string', default: '2026-06-19' },
  },
});

const [input] = positionals;
if (!input || !values.out) {
  console.error(
    'usage: import-csv <file.csv> --out <file.json> [--name …] [--tz …] [--start YYYY-MM-DD]',
  );
  process.exit(2);
}

try {
  const { snapshot, warnings, times } = importFestivalCsv(readFileSync(input, 'utf8'), {
    festivalName: values.name,
    timezone: values.tz,
    startDate: values.start,
  });

  const clock = (min: number) => {
    const h = Math.floor(min / 60) % 24;
    const m = String(min % 60).padStart(2, '0');
    return `${String(h).padStart(2, '0')}:${m}${min >= 1440 ? ' (+1 day)' : ''}`;
  };
  console.log('Times read as:');
  for (const t of times)
    console.log(`  ${t.raw.padEnd(16)} -> ${clock(t.minutes).padEnd(15)} ${t.title}`);

  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  ${w}`);
  }

  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(snapshot, null, 2) + '\n');
  const { sessions, stages, vendors, festival } = snapshot;
  console.log(
    `\nWrote ${values.out}: ${sessions.length} sessions, ${stages.length} stages, ${vendors.length} vendors, ` +
      `${festival.days.map((d) => `${d.label} ${d.date}`).join(' / ')} (${festival.timezone})`,
  );
} catch (err) {
  if (err instanceof CsvImportError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
