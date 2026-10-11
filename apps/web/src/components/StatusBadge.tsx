import type { Session } from '@nemeton/shared';

const LABEL = { delayed: 'Delayed', moved: 'Moved', cancelled: 'Cancelled' } as const;

export function StatusBadge({ session }: { session: Session }) {
  if (session.status === 'scheduled') return null;
  return <span className={`status status-${session.status}`}>{LABEL[session.status]}</span>;
}
