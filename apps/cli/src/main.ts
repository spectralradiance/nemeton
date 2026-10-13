import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { diffSnapshots, type ChangeInput, type Session, type Snapshot } from '@nemeton/shared';
import { CsvImportError, importFestivalCsv } from '@nemeton/shared/import';
import { DEFAULT_DB, openStore } from '@nemeton/server';
import {
  ApiError,
  apiConfig,
  fetchErrors,
  fetchLog,
  fetchSnapshot,
  fetchStats,
  publish,
  whoami,
} from './api';
import { describeChanges } from './describe';
import { UsageError, delaySession, findSession, moveSession, parseDuration } from './edits';

const HELP = `Nemeton organizer tools

Usage: npm run admin -- <command> [options]

Schedule changes (talk to the server; need NEMETON_TOKEN):
  delay <session> <duration>        Push a session later, e.g. 20m, 1h, 1h30m (-10m for earlier)
  move <session> [--stage S] [--at HH:MM] [--day D]
                                    Change stage and/or time. D is a day label or date.
  cancel <session>                  Mark cancelled (it stays visible, struck through)
  restore <session>                 Back to scheduled, clearing any note
  import <file.csv> [--start DATE] [--tz ZONE] [--name NAME]
                                    Publish the differences between a spreadsheet and the live schedule
  log [--limit N]                   Recent changes and who made them
  stats [--limit N]                 Sessions by how many attendees saved them (anonymous counts)
  errors [--limit N] [--stack]      Recent crash reports from attendees' apps
  whoami                            Check your token

  Options for changes: --note "…" (shown to attendees), --dry-run, --yes (skip the confirmation)
  <session> is an id like hail-fri, or part of a title if that's unambiguous.

Server setup (run on the server, edit the database directly):
  organizer add <name>              Create an organizer and print their token (shown once)
  organizer list
  organizer revoke <id>
  reset-db [--yes]                  Delete the database; it is re-seeded on next server start

Environment: NEMETON_API (default http://localhost:8787), NEMETON_TOKEN, NEMETON_DB`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    note: { type: 'string' },
    stage: { type: 'string' },
    at: { type: 'string' },
    day: { type: 'string' },
    start: { type: 'string' },
    tz: { type: 'string' },
    name: { type: 'string' },
    limit: { type: 'string' },
    token: { type: 'string' },
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
    stack: { type: 'boolean' },
  },
});
const api = apiConfig(opts.token);

async function main() {
  const [command, ...args] = positionals;
  if (!command || opts.help) return console.log(HELP);
  switch (command) {
    case 'delay':
      return editSession(args, delay);
    case 'move':
      return editSession(args, move);
    case 'cancel':
      return editSession(args, (s) => ({ ...s, status: 'cancelled', note: opts.note ?? s.note }));
    case 'restore':
      return editSession(args, ({ note: _note, ...s }) => ({
        ...s,
        status: 'scheduled',
        ...(opts.note ? { note: opts.note } : {}),
      }));
    case 'import':
      return importCsv(args);
    case 'log':
      return showLog();
    case 'stats':
      return showStats();
    case 'errors':
      return showErrors();
    case 'whoami': {
      const me = await whoami(api);
      return console.log(`Signed in as ${me.name} (${me.id}) on ${api.base}`);
    }
    case 'organizer':
      return organizer(args);
    case 'reset-db':
      return resetDb();
    default:
      throw new UsageError(`Unknown command "${command}". Run with --help.`);
  }
}

// ---------- session edits ----------

type Edit = (session: Session, snapshot: Snapshot, args: string[]) => Session;

async function editSession([query, ...rest]: string[], edit: Edit) {
  if (!query) throw new UsageError('Which session? Give an id like hail-fri.');
  const snapshot = await fetchSnapshot(api);
  const session = findSession(snapshot, query);
  const updated = edit(session, snapshot, rest);
  await review(snapshot, [{ op: 'upsert', entity: 'session', id: session.id, data: updated }]);
}

const delay: Edit = (s, snapshot, [duration]) =>
  delaySession(s, snapshot, parseDuration(duration), opts.note);

const move: Edit = (s, snapshot) =>
  moveSession(s, snapshot, { stage: opts.stage, at: opts.at, day: opts.day, note: opts.note });

// ---------- import ----------

async function importCsv([file]: string[]) {
  if (!file) throw new UsageError('Which file? e.g. import data/raw/schedule.csv');
  if (!existsSync(file)) throw new UsageError(`No such file: ${file}`);
  const live = await fetchSnapshot(api);
  const { snapshot: incoming, warnings } = importFestivalCsv(readFileSync(file, 'utf8'), {
    festivalName: opts.name ?? live.festival.name,
    timezone: opts.tz ?? live.festival.timezone,
    startDate: opts.start ?? live.festival.days[0]!.date,
    dayBoundaryMinutes: live.festival.dayBoundaryMinutes,
  });
  for (const w of warnings) console.log(`warning: ${w}`);
  const changes = diffSnapshots(live, incoming);
  if (changes.length === 0) return console.log('The live schedule already matches this file.');
  const deletes = changes.filter((c) => c.op === 'delete').length;
  if (deletes > 0) {
    console.log(
      `Note: ${deletes} item(s) are on the live schedule but not in the file and will be removed.`,
    );
  }
  // The spreadsheet knows nothing about delay/move/cancel made from the CLI on the day.
  const incomingById = new Map(incoming.sessions.map((s) => [s.id, s]));
  const undone = live.sessions.filter(
    (s) => s.status !== 'scheduled' && incomingById.get(s.id)?.status === 'scheduled',
  );
  if (undone.length > 0) {
    console.log(
      `\nWarning: ${undone.length} session(s) were changed live and this file would undo that:\n` +
        undone.map((s) => `  ${s.id} (${s.status}${s.note ? `: ${s.note}` : ''})`).join('\n') +
        '\nUpdate the spreadsheet first, or re-apply those changes after importing.',
    );
  }
  await review(live, changes);
}

// ---------- review & publish ----------

async function review(before: Snapshot, changes: ChangeInput[]) {
  console.log(`\nAgainst the live schedule (change #${before.seq}):`);
  for (const line of describeChanges(before, changes)) console.log(`  ${line}`);
  console.log(`${changes.length} change(s).`);
  if (opts['dry-run']) return console.log('Dry run: nothing published.');
  if (!(await confirm('Publish to attendees?'))) return console.log('Nothing published.');
  const result = await publish(api, changes, before.seq);
  console.log(
    `Published as change #${result.from + 1}${result.count > 1 ? `–#${result.to}` : ''}.`,
  );
}

async function confirm(question: string): Promise<boolean> {
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    throw new UsageError('Not running interactively; add --yes to publish without asking.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function showLog() {
  const limit = Number(opts.limit ?? 20);
  const changes = await fetchLog(api, limit);
  if (changes.length === 0) return console.log('No changes yet.');
  // Unambiguous local time, e.g. 2026-10-11 01:14.
  const when = { format: (d: Date) => d.toLocaleString('sv-SE').slice(0, 16) };
  for (const c of changes) {
    const what = c.op === 'delete' ? 'removed' : 'updated';
    const name =
      c.op === 'upsert'
        ? ((c.data as { title?: string; name?: string }).title ??
          (c.data as { name?: string }).name ??
          '')
        : '';
    const note = c.op === 'upsert' ? (c.data as { note?: string }).note : undefined;
    console.log(
      `#${String(c.seq).padEnd(4)} ${when.format(new Date(c.at))}  ${c.author.padEnd(16)} ${what} ${c.entity} ${c.id}${name ? ` "${name}"` : ''}${note ? ` (${note})` : ''}`,
    );
  }
}

async function showStats() {
  const limit = Number(opts.limit ?? 20);
  const stats = await fetchStats(api);
  if (stats.length === 0) return console.log('Nobody has saved any sessions yet.');
  const width = String(stats[0]!.count).length;
  for (const s of stats.slice(0, limit)) {
    console.log(`${String(s.count).padStart(width)}  ${s.title ?? `(removed) ${s.sessionId}`}`);
  }
  if (stats.length > limit) console.log(`… and ${stats.length - limit} more (--limit N)`);
}

async function showErrors() {
  const errors = await fetchErrors(api, Number(opts.limit ?? 20));
  if (errors.length === 0) return console.log('No crash reports.');
  for (const e of errors) {
    const when = new Date(e.at).toLocaleString('sv-SE').slice(0, 16);
    console.log(`${when}  ${e.path ?? ''}  [${e.version ?? '?'}]
  ${e.message}`);
    if (opts.stack && e.stack) console.log(e.stack.replace(/^/gm, '    '));
  }
}

// ---------- local server administration ----------

function organizer([action, arg]: string[]) {
  const store = openStore();
  try {
    if (action === 'add') {
      if (!arg) throw new UsageError('organizer add "<name>"');
      const o = store.addOrganizer(arg);
      console.log(`Added ${o.name} (${o.id}). Their token, shown only now:\n\n  ${o.token}\n`);
      console.log('They use it with: NEMETON_TOKEN=<token> npm run admin -- <command>');
    } else if (action === 'list') {
      const all = store.listOrganizers();
      if (all.length === 0) console.log('No organizers yet. Add one with: organizer add "<name>"');
      for (const o of all) {
        console.log(
          `${o.id.padEnd(28)} ${o.name.padEnd(24)} ${o.revokedAt ? `revoked ${o.revokedAt}` : 'active'}`,
        );
      }
    } else if (action === 'revoke') {
      if (!arg) throw new UsageError('organizer revoke <id>');
      console.log(store.revokeOrganizer(arg) ? `Revoked ${arg}.` : `No active organizer "${arg}".`);
    } else {
      throw new UsageError('organizer add|list|revoke');
    }
  } finally {
    store.close();
  }
}

async function resetDb() {
  const path = process.env.NEMETON_DB ?? DEFAULT_DB;
  if (!existsSync(path)) return console.log(`No database at ${path}.`);
  console.log(`This deletes ${path}: every change and organizer token. Clients re-download.`);
  if (!(await confirm('Delete it?'))) return console.log('Kept.');
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  console.log('Deleted. Restart the server to re-seed it from data/seed/festival.json.');
}

main().catch((err) => {
  if (err instanceof UsageError || err instanceof ApiError || err instanceof CsvImportError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
});
