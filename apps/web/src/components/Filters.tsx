import type { SessionKind } from '@nemeton/shared';
import { KIND_PLURAL } from '../lib/format';

export type KindFilter = 'all' | SessionKind;
export const KIND_FILTERS: readonly KindFilter[] = ['all', 'music', 'ritual', 'workshop'];

export function KindFilterChips({
  value,
  onChange,
}: {
  value: KindFilter;
  onChange: (v: KindFilter) => void;
}) {
  return (
    <div className="chips" role="group" aria-label="Show">
      {KIND_FILTERS.map((k) => (
        <button
          key={k}
          type="button"
          className="chip"
          aria-pressed={value === k}
          onClick={() => onChange(k)}
        >
          {k === 'all' ? 'All' : KIND_PLURAL[k]}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
