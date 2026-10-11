import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  Snapshot,
  buildLineup,
  estimateEnds,
  type LineupEntry,
  type Session,
  type SessionEnd,
  type Stage,
} from '@nemeton/shared';

// Phase 1 loads from the network on every start. Phase 2 swaps the source for IndexedDB with
// background revalidation; screens only see `useSchedule()` and shouldn't notice.

export interface Schedule {
  snapshot: Snapshot;
  stageById: Map<string, Stage>;
  sessionById: Map<string, Session>;
  ends: Map<string, SessionEnd>;
  lineup: LineupEntry[];
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; schedule: Schedule };

const ScheduleContext = createContext<Schedule | null>(null);

export function ScheduleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(() => {
    setState({ status: 'loading' });
    fetch('/api/schedule/snapshot')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => setState({ status: 'ready', schedule: index(Snapshot.parse(json)) }))
      .catch((err: Error) => setState({ status: 'error', message: err.message }));
  }, []);

  useEffect(load, [load]);

  if (state.status === 'loading') {
    return <p className="page-message">Loading the schedule…</p>;
  }
  if (state.status === 'error') {
    return (
      <div className="page-message" role="alert">
        <p>Couldn't load the schedule ({state.message}).</p>
        <button className="button" onClick={load}>
          Try again
        </button>
      </div>
    );
  }
  return <ScheduleContext.Provider value={state.schedule}>{children}</ScheduleContext.Provider>;
}

export function useSchedule(): Schedule {
  const schedule = useContext(ScheduleContext);
  if (!schedule) throw new Error('useSchedule() must be used inside <ScheduleProvider>');
  return schedule;
}

function index(snapshot: Snapshot): Schedule {
  return {
    snapshot,
    stageById: new Map(snapshot.stages.map((s) => [s.id, s])),
    sessionById: new Map(snapshot.sessions.map((s) => [s.id, s])),
    ends: estimateEnds(snapshot.sessions),
    lineup: buildLineup(snapshot.sessions),
  };
}
