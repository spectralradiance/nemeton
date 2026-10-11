import { useEffect, useState, useSyncExternalStore } from 'react';
import { zonedToUtc, type Festival } from '@nemeton/shared';

// "Now" can be overridden for demos and testing with ?now=YYYY-MM-DDTHH:mm (festival-local time)
// or a full ISO instant. The pretend clock keeps ticking from there. ?now=off resets it.

const KEY = 'nemeton.clockOffsetMs';
const listeners = new Set<() => void>();

function readOffset(): number {
  try {
    return Number(sessionStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeOffset(offset: number) {
  try {
    if (offset) sessionStorage.setItem(KEY, String(offset));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the override just won't survive a reload.
  }
  memoryOffset = offset;
  listeners.forEach((l) => l());
}

let memoryOffset = readOffset();

export function resetClock() {
  writeOffset(0);
}

/** Applies a ?now= value from the URL, if present. Returns true if it changed the clock. */
export function applyClockParam(search: string, festival: Festival): boolean {
  const value = new URLSearchParams(search).get('now');
  if (value === null) return false;
  if (value === '' || value === 'off') {
    writeOffset(0);
    return true;
  }
  const target = parseNow(value, festival);
  if (target === null) return false;
  writeOffset(target - Date.now());
  return true;
}

function parseNow(value: string, festival: Festival): number | null {
  if (/(Z|[+-]\d\d:?\d\d)$/.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return zonedToUtc(m[1]!, Number(m[2]) * 60 + Number(m[3]), festival.timezone).getTime();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Milliseconds the clock is shifted by; 0 when it's the real time. */
export function useClockOffset(): number {
  return useSyncExternalStore(subscribe, () => memoryOffset);
}

/** Current time (possibly overridden), re-rendering every `tickMs`. */
export function useNow(tickMs = 30_000): number {
  const offset = useClockOffset();
  const [real, setReal] = useState(() => Date.now());
  useEffect(() => {
    // Also refresh when the offset changes, so a new pretend time shows exactly as set.
    setReal(Date.now());
    const id = setInterval(() => setReal(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs, offset]);
  return real + offset;
}
