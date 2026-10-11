import type { Session } from '@nemeton/shared';
import { useSchedule } from '../../data/schedule';
import { formatTime } from '../../lib/format';
import { SessionRow } from '../../components/SessionRow';

/** Sessions grouped by start time, all-day sessions first. */
export function ScheduleList({ sessions, now }: { sessions: Session[]; now: number | null }) {
  const { festival } = useSchedule().snapshot;
  const allDay = sessions.filter((s) => !s.startsAt);
  const groups = new Map<string, Session[]>();
  for (const s of sessions
    .filter((s) => s.startsAt)
    .sort((a, b) => a.startsAt!.localeCompare(b.startsAt!))) {
    groups.set(s.startsAt!, [...(groups.get(s.startsAt!) ?? []), s]);
  }

  return (
    <div className="schedule-list">
      {allDay.length > 0 && (
        <section>
          <h2 className="section-label">All day</h2>
          <div className="session-list">
            {allDay.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        </section>
      )}
      {[...groups].map(([start, group]) => (
        <section key={start}>
          <h2 className="section-label">{formatTime(festival, start)}</h2>
          <div className="session-list">
            {group.map((s) => (
              <SessionRow key={s.id} session={s} now={now} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
