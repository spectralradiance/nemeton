import { useEffect, type ReactNode } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useSchedule } from '../data/schedule';
import { applyClockParam, resetClock, useClockOffset, useNow } from '../lib/clock';
import { formatDateTime } from '../lib/format';
import { festivalDayAt } from '@nemeton/shared';

const NAV = [
  {
    href: '/schedule',
    label: 'Schedule',
    match: (p: string) => p === '/' || p.startsWith('/schedule'),
  },
  { href: '/lineup', label: 'Lineup', match: (p: string) => p.startsWith('/lineup') },
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
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="nav-link"
              aria-current={item.match(location) ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <ClockBanner />
      <main id="main" className="main">
        {children}
      </main>
    </>
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
