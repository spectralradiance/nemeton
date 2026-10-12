import { useEffect, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useSchedule } from '../data/schedule';
import { applyClockParam, resetClock, useClockOffset, useNow } from '../lib/clock';
import { formatDateTime } from '../lib/format';
import { useSyncStatus } from '../data/sync';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { useFeedSeen } from '../lib/feed';
import { ChangeToast } from './ChangeToast';
import { festivalDayAt } from '@nemeton/shared';

const NAV = [
  {
    href: '/schedule',
    label: 'Schedule',
    match: (p: string) => p === '/' || p.startsWith('/schedule'),
  },
  { href: '/plan', label: 'My plan', match: (p: string) => p.startsWith('/plan') },
  { href: '/lineup', label: 'Lineup', match: (p: string) => p.startsWith('/lineup') },
  { href: '/updates', label: 'Updates', match: (p: string) => p.startsWith('/updates') },
  { href: '/vendors', label: 'Vendors', match: (p: string) => p.startsWith('/vendors') },
];

export function Shell({ children }: { children: ReactNode }) {
  const { festival } = useSchedule().snapshot;
  const [location, navigate] = useLocation();
  const search = useSearch();

  // ?now=… sets the pretend clock, then drops out of the URL so links stay clean.
  useEffect(() => {
    if (applyClockParam(search, festival)) {
      const params = new URLSearchParams(search);
      params.delete('now');
      const rest = params.toString();
      // Read the path fresh: a redirect may have changed it since this render.
      navigate(window.location.pathname + (rest ? `?${rest}` : ''), { replace: true });
    }
  }, [search, festival, navigate]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link href="/schedule" className="brand">
          {festival.name}
        </Link>
        <div className="topbar-end">
          <SyncChip />
          <nav className="nav" aria-label="Main">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="nav-link"
                aria-current={item.match(location) ? 'page' : undefined}
              >
                {item.label}
                {item.href === '/updates' && <UnreadBadge />}
              </Link>
            ))}
          </nav>
          <Link
            href="/settings"
            className="icon-link"
            aria-label="Settings"
            aria-current={location.startsWith('/settings') ? 'page' : undefined}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1c.5.4 1.1.8 1.7 1l.4 2.5h4l.4-2.5c.6-.2 1.2-.6 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
                transform="translate(-1 0)"
              />
            </svg>
          </Link>
        </div>
      </header>
      <ClockBanner />
      <ChangeToast />
      <main id="main" className="main">
        {children}
      </main>
    </>
  );
}

/** Quiet when all is well; says so when the schedule shown might be out of date. */
function SyncChip() {
  const { online, error } = useSyncStatus();
  if (online && !error) return null;
  return (
    <Link href="/settings" className="sync-chip" data-offline={!online || undefined}>
      {online ? 'Not updated' : 'Offline'}
    </Link>
  );
}

function ClockBanner() {
  const offset = useClockOffset();
  const now = useNow();
  const { festival } = useSchedule().snapshot;
  if (!offset) return null;
  const during = festivalDayAt(festival, now) !== null;
  return (
    <div className="clock-banner" role="status">
      <span>
        Pretend clock: {formatDateTime(festival, now)}
        {!during && ' (outside the festival)'}
      </span>
      <button type="button" className="link-button" onClick={resetClock}>
        Use real time
      </button>
    </div>
  );
}

/** Count of official changes not yet seen on the Updates screen. */
function UnreadBadge() {
  const [seen] = useFeedSeen();
  const unread = useLiveQuery(() => db.feed.where('seq').above(seen).count(), [seen], 0);
  if (!unread) return null;
  return (
    <span className="badge" aria-label={`, ${unread} new`}>
      {unread > 9 ? '9+' : unread}
    </span>
  );
}
