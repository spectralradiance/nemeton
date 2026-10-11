import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  buildLineup,
  estimateEnds,
  type LineupEntry,
  type Session,
  type SessionEnd,
  type Snapshot,
  type Stage,
} from '@nemeton/shared';
import { db, readSnapshot } from './db';
import { requestSync, startBackgroundSync, useSyncStatus } from './sync';

// Offline-first: screens render from IndexedDB, which updates reactively whenever a background
// sync writes a new schedule. The network is never on the path to first paint once data exists.

export interface Schedule {
  snapshot: Snapshot;
  stageById: Map<string, Stage>;
  sessionById: Map<string, Session>;
  ends: Map<string, SessionEnd>;
  lineup: LineupEntry[];
}

const ScheduleContext = createContext<Schedule | null>(null);

export function ScheduleProvider({ children }: { children: ReactNode }) {
  // undefined while IndexedDB is being read; null when nothing is stored yet.
  const snapshot = useLiveQuery(() => readSnapshot(db), [], undefined);
  const sync = useSyncStatus();
  const schedule = useMemo(() => (snapshot ? index(snapshot) : null), [snapshot]);

  useEffect(() => startBackgroundSync(db), []);

  if (snapshot === undefined) return null; // a local read; usually done before the first frame
  if (!schedule) {
    return (
      <div className="page-message" role={sync.error ? 'alert' : 'status'}>
        {sync.error ? (
          <>
            <h1 className="page-title">No schedule on this device yet</h1>
            <p>
              Connect to the internet once to download it. After that it works offline.
              <br />
              <span className="muted">({sync.error})</span>
            </p>
            <button className="button" onClick={() => void requestSync(db).catch(() => {})}>
              Try again
            </button>
          </>
        ) : (
          <p>Downloading the schedule…</p>
        )}
      </div>
    );
  }
  return <ScheduleContext.Provider value={schedule}>{children}</ScheduleContext.Provider>;
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
