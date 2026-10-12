import { useMemo } from 'react';
import { Link } from 'wouter';
import { findClashes, type Session } from '@nemeton/shared';
import type { ItineraryItem } from '../data/db';
import { togglePlan, useOutboxError, usePendingCount, usePlan } from '../data/plan';
import { useSchedule } from '../data/schedule';
import { useSyncStatus } from '../data/sync';
import { useNow } from '../lib/clock';
import { formatDay, formatTime, formatTimeRange } from '../lib/format';
import { buildIcs, downloadIcs } from '../lib/ics';
import { SessionRow } from '../components/SessionRow';
import { Star } from '../components/SaveButton';

/** The attendee's own schedule: saved sessions by day, with clashes and organizer changes flagged. */
export function Plan() {
  const { snapshot, sessionById, ends, stageById } = useSchedule();
  const { festival } = snapshot;
  const plan = usePlan();
  const now = useNow();

  const { sessions, orphans, clashes } = useMemo(() => {
    const sessions: Session[] = [];
    const orphans: ItineraryItem[] = [];
    for (const item of plan.values()) {
      const s = sessionById.get(item.sessionId);
      if (s) sessions.push(s);
      else orphans.push(item);
    }
    sessions.sort(
      (a, b) => a.day.localeCompare(b.day) || (a.startsAt ?? '').localeCompare(b.startsAt ?? ''),
    );
    return { sessions, orphans, clashes: findClashes(sessions, ends) };
  }, [plan, sessionById, ends]);

  const exportIcs = () =>
    downloadIcs(
      buildIcs(festival, sessions, ends, (id) => stageById.get(id)?.name ?? id),
      'my-festival-plan.ics',
    );

  return (
    <div className="plan">
      <h1 className="page-title">My plan</h1>
      <PlanStatus />

      {plan.size === 0 ? (
        <div className="empty">
          <p>Nothing saved yet.</p>
          <p>
            Open any session and tap <strong>Add to my plan</strong>. Your plan stays on this device
            and works offline.
          </p>
          <Link href="/schedule" className="button">
            Browse the schedule
          </Link>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <p className="muted plan-count">
              {plan.size} saved{clashes.size > 0 && ` · ${clashes.size} clashing`}
            </p>
            <button className="button" onClick={exportIcs} disabled={sessions.length === 0}>
              Add to calendar (.ics)
            </button>
          </div>

          {orphans.length > 0 && (
            <section className="plan-day">
              <h2 className="section-label">No longer on the schedule</h2>
              <ul className="plan-list">
                {orphans.map((item) => (
                  <li key={item.sessionId} className="plan-item" data-orphan>
                    <div className="plan-orphan">
                      <strong>{item.title ?? item.sessionId}</strong>
                      <span className="muted">The organizers removed this session.</span>
                    </div>
                    <RemoveButton sessionId={item.sessionId} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {festival.days.map((day) => {
            const daySessions = sessions.filter((s) => s.day === day.date);
            if (daySessions.length === 0) return null;
            return (
              <section key={day.date} className="plan-day">
                <h2 className="section-label">{formatDay(day.date, 'long')}</h2>
                <ul className="plan-list">
                  {daySessions.map((s) => {
                    const clash = clashes.get(s.id);
                    const end = ends.get(s.id);
                    return (
                      <li key={s.id} className="plan-item" data-clash={clash ? true : undefined}>
                        <div className="plan-main">
                          <SessionRow session={s} now={now} />
                          {s.startsAt && end && (
                            <p className="plan-when muted">
                              {formatTimeRange(festival, s.startsAt, end.endsAt, end.estimated)}
                            </p>
                          )}
                          {s.status !== 'scheduled' && s.note && (
                            <p className="plan-flag" data-status={s.status}>
                              {s.note}
                            </p>
                          )}
                          {clash && (
                            <p className="plan-flag" data-clash>
                              Clashes with{' '}
                              {clash
                                .map((c) => `${c.title} (${formatTime(festival, c.startsAt!)})`)
                                .join(', ')}
                            </p>
                          )}
                        </div>
                        <RemoveButton sessionId={s.id} />
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}

function RemoveButton({ sessionId }: { sessionId: string }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label="Remove from my plan"
      title="Remove from my plan"
      onClick={() => void togglePlan(sessionId, false)}
    >
      <Star filled size={20} />
    </button>
  );
}

/** Whether edits have reached the server yet, in plain words. */
function PlanStatus() {
  const pending = usePendingCount();
  const { online } = useSyncStatus();
  const rejected = useOutboxError();
  if (rejected)
    return (
      <p className="plan-status" data-error>
        {rejected}
      </p>
    );
  if (pending === 0) return null;
  return (
    <p className="plan-status">
      {pending} change{pending === 1 ? '' : 's'} saved on this device,{' '}
      {online ? 'syncing…' : "will sync when you're back online."}
    </p>
  );
}
