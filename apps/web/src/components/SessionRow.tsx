import { Link } from 'wouter';
import type { Session } from '@nemeton/shared';
import { useSchedule } from '../data/schedule';
import { KIND_LABEL, formatTime, shortDayLabel } from '../lib/format';
import { StageName } from './StageName';
import { StatusBadge } from './StatusBadge';
import { SavedMarker } from './SaveButton';

interface Props {
  session: Session;
  /** When set, sessions that have ended by this time are dimmed. */
  now?: number | null;
  /** Prefix the time with the day, for lists that span days. */
  showDay?: boolean;
}

export function SessionRow({ session: s, now = null, showDay = false }: Props) {
  const { snapshot, ends } = useSchedule();
  const { festival } = snapshot;
  const end = ends.get(s.id);
  const past = now !== null && end !== undefined && Date.parse(end.endsAt) <= now;

  return (
    <Link
      href={`/session/${s.id}`}
      className="session-row"
      data-past={past || undefined}
      data-status={s.status}
    >
      <span className="session-time">
        {showDay && <span className="session-day">{shortDayLabel(festival, s.day)}</span>}
        {s.startsAt ? formatTime(festival, s.startsAt) : 'All day'}
      </span>
      <span className="session-main">
        <span className="session-title">
          <SavedMarker sessionId={s.id} />
          {s.title}
          {s.tags.map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
          <StatusBadge session={s} />
        </span>
        <span className="session-meta">
          <StageName stageId={s.stageId} />
          <span>{KIND_LABEL[s.kind]}</span>
          {s.people.length > 0 && <span>{s.people.join(' & ')}</span>}
        </span>
      </span>
    </Link>
  );
}
