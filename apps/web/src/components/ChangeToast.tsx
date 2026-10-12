import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { FeedItem } from '../data/db';
import { useSchedule } from '../data/schedule';
import { onScheduleChanged } from '../data/sync';
import { describeFeedItem } from '../lib/feed';
import { usePlan } from '../data/plan';

const SHOW_MS = 10_000;

/**
 * Pops up when organizers change a session in the attendee's plan while the app is open.
 * Every change, saved or not, is listed in the Updates tab.
 */
export function ChangeToast() {
  const { snapshot, stageById } = useSchedule();
  const [items, setItems] = useState<FeedItem[]>([]);
  const plan = usePlan();
  const planRef = useRef(plan);
  planRef.current = plan;

  // Changes arriving while the toast is up add to it rather than replacing it.
  useEffect(
    () =>
      onScheduleChanged((latest) => {
        // Only interrupt for sessions the attendee saved; the Updates tab has everything.
        const mine = latest.filter((i) => planRef.current.has(i.sessionId));
        if (mine.length === 0) return;
        setItems((shown) => {
          const seqs = new Set(shown.map((i) => i.seq));
          return [...shown, ...mine.filter((i) => !seqs.has(i.seq))];
        });
      }),
    [],
  );
  useEffect(() => {
    if (items.length === 0) return;
    const timer = setTimeout(() => setItems([]), SHOW_MS);
    return () => clearTimeout(timer);
  }, [items]);

  if (items.length === 0) return null;
  const close = () => setItems([]);

  if (items.length > 1) {
    return (
      <div className="change-toast" role="status">
        <span className="change-toast-text">
          <strong>{items.length} changes to your plan</strong>
        </span>
        <Link href="/updates" className="change-toast-action" onClick={close}>
          See updates
        </Link>
        <button className="change-toast-close" aria-label="Dismiss" onClick={close}>
          ×
        </button>
      </div>
    );
  }

  const item = items[0]!;
  const d = describeFeedItem(item, snapshot.festival, (id) => stageById.get(id)?.name ?? id);
  return (
    <div className="change-toast" role="status" data-tone={d.tone}>
      <span className="change-toast-text">
        <strong>
          {d.label}: {d.title}
        </strong>
        <span className="change-toast-detail">{d.note ?? d.now}</span>
      </span>
      {item.op === 'upsert' && (
        <Link href={`/session/${item.sessionId}`} className="change-toast-action" onClick={close}>
          View
        </Link>
      )}
      <button className="change-toast-close" aria-label="Dismiss" onClick={close}>
        ×
      </button>
    </div>
  );
}
