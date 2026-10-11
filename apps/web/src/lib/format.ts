import type { Festival, Link, SessionKind } from '@nemeton/shared';

// All times render in the festival's timezone, never the device's.

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = timeZone + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) cache.set(key, (f = new Intl.DateTimeFormat('en-US', { timeZone, ...opts })));
  return f;
}

export function formatTime(festival: Festival, instant: string | number): string {
  return fmt(festival.timezone, { hour: 'numeric', minute: '2-digit' }).format(new Date(instant));
}

/** "Sat, Jun 20, 1:30 AM": the calendar date and time at the festival. */
export function formatDateTime(festival: Festival, instant: string | number): string {
  return fmt(festival.timezone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(instant));
}

/** "Fri, Jun 19" for a festival-day ISO date. */
export function formatDay(date: string, style: 'short' | 'long' = 'short'): string {
  // Noon UTC keeps the calendar date stable in every zone.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: style,
    month: style === 'short' ? 'short' : 'long',
    day: 'numeric',
  }).format(new Date(`${date}T12:00:00Z`));
}

export function shortDayLabel(festival: Festival, date: string): string {
  return festival.days.find((d) => d.date === date)?.label.slice(0, 3) ?? formatDay(date);
}

export const KIND_LABEL: Record<SessionKind, string> = {
  music: 'Music',
  ritual: 'Ritual',
  workshop: 'Workshop',
};

export const KIND_PLURAL: Record<SessionKind, string> = {
  music: 'Music',
  ritual: 'Rituals',
  workshop: 'Workshops',
};

export function linkLabel(link: Link): string {
  const url = new URL(link.url);
  switch (link.kind) {
    case 'instagram': {
      const handle = url.pathname.split('/').filter(Boolean)[0];
      return handle ? `@${handle}` : 'Instagram';
    }
    case 'bandcamp':
      return 'Bandcamp';
    case 'facebook':
      return 'Facebook';
    case 'youtube':
      return 'YouTube';
    case 'website':
      return url.hostname.replace(/^www\./, '');
  }
}

/** Splits stored text on blank lines. */
export function paragraphs(text: string | undefined): string[] {
  return text ? text.split(/\n{2,}/) : [];
}

/** "10:00 – ~11:00 AM", or "11:30 AM – 12:30 PM" when the half of the day changes. */
export function formatTimeRange(
  festival: Festival,
  start: string | number,
  end: string | number,
  estimated: boolean,
): string {
  const a = formatTime(festival, start);
  const b = formatTime(festival, end);
  const sameHalf = a.slice(-2) === b.slice(-2);
  return `${sameHalf ? a.slice(0, -3) : a} – ${estimated ? '~' : ''}${b}`;
}
