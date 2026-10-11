import type { Session } from '@nemeton/shared';
import { sessionsOnAt, sessionsUpNext } from '@nemeton/shared';
import { useSchedule } from '../../data/schedule';
import { formatTime } from '../../lib/format';
import { SessionRow } from '../../components/SessionRow';

export function NowPanel({ sessions, now }: { sessions: Session[]; now: number }) {
  const { snapshot, ends } = useSchedule();
  const { festival } = snapshot;
  const on = sessionsOnAt(festival, sessions, ends, now).filter((s) => s.startsAt);
  const next = sessionsUpNext(festival, sessions, now);

  if (on.length === 0 && next.length === 0) return null;
  return (
    <section className="now-panel" aria-label="Happening now">
      {on.length > 0 && (
        <div>
          <h2 className="section-label">
            <span className="live-dot" aria-hidden="true" /> On now
          </h2>
          <div className="session-list">
            {on.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        </div>
      )}
      {next.length > 0 && (
        <div>
          <h2 className="section-label">Up next · {formatTime(festival, next[0]!.startsAt!)}</h2>
          <div className="session-list">
            {next.map((s) => (
              <SessionRow key={s.id} session={s} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
