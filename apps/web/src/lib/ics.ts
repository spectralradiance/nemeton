import { addDays, type Festival, type Session, type SessionEnd } from '@nemeton/shared';

// iCalendar (RFC 5545) export of the attendee's plan, for calendar apps. Times are UTC; calendar
// apps show them in local time. UIDs are stable, so re-importing updates events instead of
// duplicating them.

/** Escapes TEXT values: backslash, semicolon, comma and newlines. */
function text(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Folds lines longer than 75 octets, as the spec requires, without splitting UTF-8 characters. */
function fold(line: string): string {
  const bytes = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  for (const ch of line) {
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes.encode(current + ch).length > limit) {
      parts.push(current);
      current = ch;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const utc = (iso: string | number) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const date = (isoDate: string) => isoDate.replace(/-/g, '');

export function buildIcs(
  festival: Festival,
  sessions: readonly Session[],
  ends: Map<string, SessionEnd>,
  stageName: (id: string) => string,
  now = Date.now(),
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Nemeton//Festival schedule//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${text(`${festival.name}: my plan`)}`,
  ];
  for (const s of sessions) {
    const description = [
      s.status !== 'scheduled' ? `${s.status[0]!.toUpperCase()}${s.status.slice(1)}.` : '',
      s.note ?? '',
      s.people.length ? `With ${s.people.join(' & ')}.` : '',
      s.startsAt && ends.get(s.id)?.estimated ? 'End time is an estimate.' : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push('BEGIN:VEVENT', `UID:${s.id}@nemeton`, `DTSTAMP:${utc(now)}`);
    if (s.startsAt) {
      lines.push(`DTSTART:${utc(s.startsAt)}`);
      const end = ends.get(s.id);
      if (end) lines.push(`DTEND:${utc(end.endsAt)}`);
    } else {
      lines.push(
        `DTSTART;VALUE=DATE:${date(s.day)}`,
        `DTEND;VALUE=DATE:${date(addDays(s.day, 1))}`,
      );
    }
    lines.push(`SUMMARY:${text(s.subtitle ? `${s.title}: ${s.subtitle}` : s.title)}`);
    lines.push(`LOCATION:${text(stageName(s.stageId))}`);
    if (description) lines.push(`DESCRIPTION:${text(description)}`);
    if (s.status === 'cancelled') lines.push('STATUS:CANCELLED');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Offers the calendar file as a download. */
export function downloadIcs(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
