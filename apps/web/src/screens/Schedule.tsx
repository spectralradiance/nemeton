import { useMemo } from 'react';
import { Link, Redirect, useParams } from 'wouter';
import { festivalDayAt, festivalDayBounds } from '@nemeton/shared';
import { useSchedule } from '../data/schedule';
import { useNow } from '../lib/clock';
import { formatDay } from '../lib/format';
import { usePref } from '../lib/prefs';
import { KIND_FILTERS, KindFilterChips, Segmented, type KindFilter } from '../components/Filters';
import { NowPanel } from './schedule/NowPanel';
import { ScheduleGrid } from './schedule/ScheduleGrid';
import { ScheduleList } from './schedule/ScheduleList';

type View = 'list' | 'grid';
const VIEWS = [
  { value: 'list', label: 'List' },
  { value: 'grid', label: 'By stage' },
] as const;

export function Schedule() {
  const { snapshot } = useSchedule();
  const { festival, sessions } = snapshot;
  const params = useParams<{ date?: string }>();
  const now = useNow();
  const today = festivalDayAt(festival, now);

  const [view, setView] = usePref<View>(
    'scheduleView',
    () => (window.matchMedia('(min-width: 900px)').matches ? 'grid' : 'list'),
    ['list', 'grid'],
  );
  const [kind, setKind] = usePref<KindFilter>('scheduleKind', () => 'all', KIND_FILTERS);

  const selected = params.date ?? today ?? festival.days[0]!.date;
  const daySessions = useMemo(
    () => sessions.filter((s) => s.day === selected && (kind === 'all' || s.kind === kind)),
    [sessions, selected, kind],
  );

  if (!festival.days.some((d) => d.date === selected)) return <Redirect to="/schedule" replace />;

  const { start, end } = festivalDayBounds(festival, selected);
  const live = now >= start && now < end;

  return (
    <div className="schedule">
      <h1 className="visually-hidden">Schedule, {formatDay(selected, 'long')}</h1>
      <nav className="day-tabs" aria-label="Festival days">
        {festival.days.map((d) => (
          <Link
            key={d.date}
            href={`/schedule/${d.date}`}
            className="day-tab"
            aria-current={d.date === selected ? 'page' : undefined}
          >
            <span className="day-tab-label">{d.label}</span>
            <span className="day-tab-date">
              {d.date === today ? 'Today' : formatDay(d.date).replace(/^\w+, /, '')}
            </span>
          </Link>
        ))}
      </nav>

      <div className="toolbar">
        <KindFilterChips value={kind} onChange={setKind} />
        <Segmented label="Layout" options={VIEWS} value={view} onChange={setView} />
      </div>

      {live && <NowPanel sessions={daySessions} now={now} />}

      {daySessions.length === 0 ? (
        <p className="empty">Nothing matches this filter on {formatDay(selected, 'long')}.</p>
      ) : view === 'list' ? (
        <ScheduleList sessions={daySessions} now={live ? now : null} />
      ) : (
        <ScheduleGrid day={selected} sessions={daySessions} now={live ? now : null} />
      )}
    </div>
  );
}
