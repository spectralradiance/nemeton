import { useEffect, useState } from 'react';
import { Snapshot, type Session } from '@nemeton/shared';

// Phase 0 placeholder: proves web -> server -> shared schema end to end.
// Phase 1 replaces this with the real schedule screens; Phase 2 moves loading to IndexedDB.

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: Snapshot };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    fetch('/api/schedule/snapshot')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => setState({ status: 'ready', snapshot: Snapshot.parse(json) }))
      .catch((err: Error) => setState({ status: 'error', message: err.message }));
  }, []);

  if (state.status === 'loading') return <main className="page">Loading…</main>;
  if (state.status === 'error')
    return <main className="page">Couldn't load the schedule: {state.message}</main>;

  const { festival, stages, sessions, vendors } = state.snapshot;
  const stageName = new Map(stages.map((s) => [s.id, s.name]));
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: festival.timezone,
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <main className="page">
      <h1>{festival.name}</h1>
      <p className="muted">
        {sessions.length} sessions · {stages.length} stages · {vendors.length} vendors · times in{' '}
        {festival.timezone}
      </p>
      {festival.days.map((day) => (
        <section key={day.date}>
          <h2>{day.label}</h2>
          <ul className="sessions">
            {sessions
              .filter((s) => s.day === day.date)
              .sort(byStart)
              .map((s) => (
                <li key={s.id}>
                  <span className="time">
                    {s.startsAt ? time.format(new Date(s.startsAt)) : 'All day'}
                  </span>
                  <span>
                    <strong>{s.title}</strong>
                    {s.tags.map((t) => (
                      <span key={t} className="tag">
                        {t}
                      </span>
                    ))}
                    <br />
                    <span className="muted">
                      {stageName.get(s.stageId)} · {s.kind}
                      {s.people.length > 0 && ` · ${s.people.join(', ')}`}
                    </span>
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

/** All-day sessions first, then by start time. */
function byStart(a: Session, b: Session): number {
  return (a.startsAt ?? '').localeCompare(b.startsAt ?? '');
}
