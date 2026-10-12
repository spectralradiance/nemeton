import type { Session } from '@nemeton/shared';
import { togglePlan, usePlan } from '../data/plan';

export function Star({ filled, size = 18 }: { filled: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="star">
      <path
        d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Add to / remove from the attendee's plan. Works offline; syncs later. */
export function SaveButton({ session }: { session: Session }) {
  const saved = usePlan().has(session.id);
  return (
    <button
      type="button"
      className="save-button"
      aria-pressed={saved}
      onClick={() => void togglePlan(session.id, !saved, session.title)}
    >
      <Star filled={saved} />
      {saved ? 'In my plan' : 'Add to my plan'}
    </button>
  );
}

/** Small marker for lists: shown only for saved sessions. */
export function SavedMarker({ sessionId }: { sessionId: string }) {
  if (!usePlan().has(sessionId)) return null;
  return (
    <span className="saved-marker" title="In my plan">
      <Star filled size={14} />
      <span className="visually-hidden">In my plan</span>
    </span>
  );
}
