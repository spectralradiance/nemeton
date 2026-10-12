import { useEffect } from 'react';
import { Link } from 'wouter';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type FeedItem } from '../data/db';
import { useSchedule } from '../data/schedule';
import { useSyncStatus } from '../data/sync';
import { describeFeedItem, useFeedSeen } from '../lib/feed';
import { usePlan } from '../data/plan';
import { formatDateTime } from '../lib/format';

/** Official schedule changes, newest first. */
export function Updates() {
  const feed = useLiveQuery(() => db.feed.orderBy('seq').reverse().toArray(), []);
  const [seen, markSeen] = useFeedSeen();
  const { live, online } = useSyncStatus();
  const newest = feed?.[0]?.seq ?? 0;

  // Viewing the feed marks everything in it as seen, including items arriving while it's open.
  useEffect(() => {
    if (newest) markSeen(newest);
  }, [newest, markSeen]);

  return (
    <div className="updates">
      <h1 className="page-title">Updates</h1>
      <p className="muted">
        Changes from the organizers.{' '}
        {live
          ? 'New ones appear here as they happen.'
          : online
            ? 'Checking for new ones when you open the app.'
            : "You're offline; new ones will arrive when you reconnect."}
      </p>
      {feed && feed.length === 0 && <p className="empty">No changes to the schedule yet.</p>}
      <ol className="feed">
        {feed?.map((item) => (
          <FeedRow key={item.seq} item={item} unread={item.seq > seen} />
        ))}
      </ol>
    </div>
  );
}

function FeedRow({ item, unread }: { item: FeedItem; unread: boolean }) {
  const { snapshot, stageById, sessionById } = useSchedule();
  const d = describeFeedItem(item, snapshot.festival, (id) => stageById.get(id)?.name ?? id);
  const exists = sessionById.has(item.sessionId);
  const inPlan = usePlan().has(item.sessionId);
  return (
    <li className="feed-item" data-unread={unread || undefined}>
      <div className="feed-head">
        <span>
          <span className={`feed-label tone-${d.tone}`}>{d.label}</span>
          {inPlan && <span className="tag">In your plan</span>}
        </span>
        <time dateTime={item.at} className="muted">
          {formatDateTime(snapshot.festival, item.at)}
        </time>
      </div>
      {exists ? (
        <Link href={`/session/${item.sessionId}`} className="feed-title">
          {d.title}
        </Link>
      ) : (
        <span className="feed-title">{d.title}</span>
      )}
      {d.note && <p className="feed-note">{d.note}</p>}
      {(d.now || d.was) && (
        <p className="feed-where">
          {d.now}
          {d.now && d.was && <br />}
          {d.was && <span className="muted">{d.was}</span>}
        </p>
      )}
    </li>
  );
}
