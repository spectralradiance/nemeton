/** Offset of `timeZone` from UTC at the given instant, in minutes (e.g. -420 for PDT). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * Converts a wall-clock time in `timeZone` to a UTC instant.
 * `minutes` may exceed 1440 to express times after midnight on following dates.
 */
export function zonedToUtc(isoDate: string, minutes: number, timeZone: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const wallAsUtc = Date.UTC(y, m - 1, d, 0, minutes);
  // Two passes settle the offset even when the guess lands on the other side of a DST change.
  let offset = zoneOffsetMinutes(new Date(wallAsUtc), timeZone);
  offset = zoneOffsetMinutes(new Date(wallAsUtc - offset * 60_000), timeZone);
  return new Date(wallAsUtc - offset * 60_000);
}

/** Adds whole days to an ISO date. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
