import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import type { FeedItem } from '../data/db';
import { useSchedule } from '../data/schedule';
import { onScheduleChanged } from '../data/sync';
import { describeFeedItem } from '../lib/feed';

const SHOW_MS = 10_000;

/**
 * Pops up when organizers change the schedule while the app is open. (Phase 5 narrows this to
 * sessions in the attendee's itinerary; everything stays in the Updates feed.)
 */
export function ChangeToast() {
  const { snapshot, stageById } = useSchedule();
  const [items, setItems] = useState<FeedItem[]>([]);

  // Changes arriving while the toast is up add to it rather than replacing it.
  useEffect(
    () =>
      onScheduleChanged((latest) =>
        setItems((shown) => {
          const seqs = new Set(shown.map((i) => i.seq));
          return [...shown, ...latest.filter((i) => !seqs.has(i.seq))];
        }),
      ),
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
          <strong>{items.length} schedule changes</strong>
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
