import { useCallback, useState } from 'react';

/** A per-device UI preference in localStorage. Falls back to memory when storage is unavailable. */
export function usePref<T extends string>(
  key: string,
  initial: () => T,
  allowed: readonly T[],
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(`nemeton.${key}`);
      if (stored !== null && (allowed as readonly string[]).includes(stored)) return stored as T;
    } catch {
      // ignore
    }
    return initial();
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(`nemeton.${key}`, v);
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [value, set];
}
