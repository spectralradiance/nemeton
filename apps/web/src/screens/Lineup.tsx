import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { LineupEntry } from '@nemeton/shared';
import { useSchedule } from '../data/schedule';
import { KIND_LABEL, formatTime, shortDayLabel } from '../lib/format';
import { usePref } from '../lib/prefs';
import { KIND_FILTERS, KindFilterChips, type KindFilter } from '../components/Filters';
import { StageName } from '../components/StageName';

/** Case- and accent-insensitive, so "fosphene" finds Føsphene. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae');
}

function initial(title: string): string {
  const c = fold(title.replace(/^the\s+/i, ''))[0] ?? '#';
  return /[a-z]/.test(c) ? c.toUpperCase() : '#';
}

export function Lineup() {
  const { lineup } = useSchedule();
  const [query, setQuery] = useState('');
  const [kind, setKind] = usePref<KindFilter>('lineupKind', () => 'all', KIND_FILTERS);

  const groups = useMemo(() => {
    const q = fold(query.trim());
    const matches = lineup.filter(
      (e) =>
        (kind === 'all' || e.kind === kind) &&
        (!q ||
          [e.title, ...e.sessions.flatMap((s) => [...s.people, s.origin ?? '', s.subtitle ?? ''])]
            .map(fold)
            .some((t) => t.includes(q))),
    );
    const byLetter = new Map<string, LineupEntry[]>();
    for (const e of matches)
      byLetter.set(initial(e.title), [...(byLetter.get(initial(e.title)) ?? []), e]);
    return [...byLetter];
  }, [lineup, query, kind]);

  return (
    <div className="lineup">
      <h1 className="page-title">Lineup</h1>
      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search acts, workshops, people…"
          aria-label="Search the lineup"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <KindFilterChips value={kind} onChange={setKind} />
      </div>

      {groups.length === 0 && <p className="empty">No matches.</p>}
      {groups.map(([letter, entries]) => (
        <section key={letter} className="lineup-group">
          <h2 className="lineup-letter">{letter}</h2>
          <ul className="lineup-list">
            {entries.map((e) => (
              <li key={e.key}>
                <LineupRow entry={e} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function LineupRow({ entry }: { entry: LineupEntry }) {
  const { festival } = useSchedule().snapshot;
  const first = entry.sessions[0]!;
  const origin = first.origin;
  return (
    <Link href={`/session/${first.id}`} className="lineup-row">
      <span className="lineup-title">{entry.title}</span>
      <span className="session-meta">
        <span>{KIND_LABEL[entry.kind]}</span>
        {origin && <span>{origin}</span>}
        {first.people.length > 0 && <span>{first.people.join(' & ')}</span>}
      </span>
      <span className="lineup-when">
        {entry.sessions.map((s) => (
          <span key={s.id}>
            {shortDayLabel(festival, s.day)}{' '}
            {s.startsAt ? formatTime(festival, s.startsAt) : 'all day'}{' '}
            <StageName stageId={s.stageId} />
          </span>
        ))}
      </span>
    </Link>
  );
}
