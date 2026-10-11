import { useCallback, useSyncExternalStore } from 'react';
import type { Festival, Session } from '@nemeton/shared';
import type { FeedItem } from '../data/db';
import { formatTime, shortDayLabel } from './format';

export type Tone = 'danger' | 'warn' | 'ok' | 'info';

export interface FeedDescription {
  /** "Cancelled", "Delayed", "Moved", "Added", "Removed", "Back on", "Changed", "Updated". */
  label: string;
  tone: Tone;
  title: string;
  /** e.g. "Now Fri 8:50 PM · Stage 1" */
  now?: string;
  /** e.g. "Was Fri 8:30 PM · Stage 1" (only when this device saw the change happen) */
  was?: string;
  note?: string;
}

function where(festival: Festival, s: Session, stageName: (id: string) => string): string {
  const when = s.startsAt
    ? `${shortDayLabel(festival, s.day)} ${formatTime(festival, s.startsAt)}`
    : `${shortDayLabel(festival, s.day)}, all day`;
  return `${when} · ${stageName(s.stageId)}`;
}

/** Plain-language summary of one official change, for the Updates feed and toasts. */
export function describeFeedItem(
  item: FeedItem,
  festival: Festival,
  stageName: (id: string) => string,
): FeedDescription {
  const { before, after } = item;
  const title = after?.title ?? before?.title ?? item.sessionId;

  if (item.op === 'delete' || !after) {
    return {
      label: 'Removed',
      tone: 'danger',
      title,
      was: before && `Was ${where(festival, before, stageName)}`,
    };
  }

  const moved =
    !!before &&
    (before.startsAt !== after.startsAt ||
      before.stageId !== after.stageId ||
      before.day !== after.day);
  const base = {
    title,
    now: `Now ${where(festival, after, stageName)}`,
    was: moved ? `Was ${where(festival, before!, stageName)}` : undefined,
    note: after.note,
  };

  if (item.added) return { ...base, label: 'Added', tone: 'ok', was: undefined };
  if (after.status === 'cancelled')
    return { ...base, label: 'Cancelled', tone: 'danger', now: undefined };
  if (after.status === 'scheduled' && before && before.status !== 'scheduled') {
    return { ...base, label: 'Back on', tone: 'ok' };
  }
  if (after.status === 'delayed') return { ...base, label: 'Delayed', tone: 'warn' };
  if (after.status === 'moved') return { ...base, label: 'Moved', tone: 'warn' };
  return { ...base, label: moved ? 'Changed' : 'Updated', tone: 'info' };
}

// ---------- "seen" marker for the unread badge (per device) ----------

const SEEN_KEY = 'nemeton.feedSeen';
const seenListeners = new Set<() => void>();

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function useFeedSeen(): [number, (seq: number) => void] {
  const seen = useSyncExternalStore((l) => {
    seenListeners.add(l);
    return () => seenListeners.delete(l);
  }, readSeen);
  const markSeen = useCallback((seq: number) => {
    if (seq <= readSeen()) return;
    try {
      localStorage.setItem(SEEN_KEY, String(seq));
    } catch {
      // Storage blocked: the badge just won't remember.
    }
    seenListeners.forEach((l) => l());
  }, []);
  return [seen, markSeen];
}
