import { Link } from 'wouter';
import type { Session } from '@nemeton/shared';
import { useSchedule } from '../../data/schedule';
import { KIND_LABEL, formatTime, formatTimeRange } from '../../lib/format';
import { stageStyle } from '../../components/StageName';
import { StatusBadge } from '../../components/StatusBadge';

const PX_PER_MIN = 1.5;
const HOUR = 3_600_000;

/** Timeline with one column per stage. Scrolls both ways inside its own box on small screens. */
export function ScheduleGrid({
  day,
  sessions,
  now,
}: {
  day: string;
  sessions: Session[];
  now: number | null;
}) {
  const { snapshot, ends } = useSchedule();
  const { festival, stages } = snapshot;

  // Keep every stage that has anything that day, so columns don't jump around when filtering.
  const dayStageIds = new Set(snapshot.sessions.filter((s) => s.day === day).map((s) => s.stageId));
  const columns = stages.filter((s) => dayStageIds.has(s.id));
  const allDay = sessions.filter((s) => !s.startsAt);
  const timed = sessions.filter((s) => s.startsAt);

  const starts = timed.map((s) => Date.parse(s.startsAt!));
  const finishes = timed.map((s) => Date.parse(ends.get(s.id)!.endsAt));
  const from = Math.floor(Math.min(...starts) / HOUR) * HOUR;
  const to = Math.ceil(Math.max(...finishes) / HOUR) * HOUR;
  const y = (t: number) => ((t - from) / 60_000) * PX_PER_MIN;
  const hours = Array.from({ length: (to - from) / HOUR }, (_, i) => from + i * HOUR);

  return (
    <div className="schedule-grid-wrap">
      {allDay.length > 0 && (
        <ul className="all-day-strip" aria-label="All day">
          {allDay.map((s) => (
            <li key={s.id}>
              <Link href={`/session/${s.id}`} className="all-day-item">
                <span className="section-label">All day</span> {s.title}
                {s.tags.map((t) => (
                  <span key={t} className="tag">
                    {t}
                  </span>
                ))}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {timed.length > 0 && (
        <div className="grid-scroll" tabIndex={0} aria-label="Timeline by stage">
          <div
            className="grid"
            style={
              { '--cols': columns.length, '--body-height': `${y(to)}px` } as React.CSSProperties
            }
          >
            <div className="grid-corner" />
            {columns.map((stage) => (
              <div key={stage.id} className="grid-stage" style={stageStyle(stage.order)}>
                {stage.name}
              </div>
            ))}

            <div className="grid-hours" aria-hidden="true">
              {hours.map((h) => (
                <span key={h} style={{ top: y(h) }}>
                  {formatTime(festival, h).replace(':00', '')}
                </span>
              ))}
            </div>

            {columns.map((stage, i) => (
              <div
                key={stage.id}
                className="grid-column"
                style={{ ...stageStyle(stage.order), gridColumn: i + 2 }}
              >
                {timed
                  .filter((s) => s.stageId === stage.id)
                  .map((s) => {
                    const start = Date.parse(s.startsAt!);
                    const end = ends.get(s.id)!;
                    const past = now !== null && Date.parse(end.endsAt) <= now;
                    return (
                      <Link
                        key={s.id}
                        href={`/session/${s.id}`}
                        className="grid-block"
                        data-kind={s.kind}
                        data-past={past || undefined}
                        data-status={s.status}
                        style={{ top: y(start), height: y(Date.parse(end.endsAt)) - y(start) }}
                      >
                        <span className="grid-block-time">
                          {formatTimeRange(festival, start, end.endsAt, end.estimated)}
                        </span>
                        <span className="grid-block-title">{s.title}</span>
                        <span className="grid-block-kind">
                          {KIND_LABEL[s.kind]} <StatusBadge session={s} />
                        </span>
                      </Link>
                    );
                  })}
              </div>
            ))}

            {now !== null && now >= from && now < to && (
              <div className="grid-overlay" aria-hidden="true">
                <div className="now-line" style={{ top: y(now) }}>
                  <span>{formatTime(festival, now)}</span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
