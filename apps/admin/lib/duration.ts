const MINUTES_PER_HOUR = 60;
const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Parses the operator-facing `hours,minutes` notation. A dot is accepted as
 * an alternative separator so it behaves like the price field. The right
 * side is minutes, not a floating-point fraction of an hour: `1,30` means
 * exactly one hour and thirty minutes.
 */
export function parseHoursAndMinutes(input: string): number | null {
  const trimmed = input.replace(/\s/g, "");
  if (!trimmed) return null;
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? "0");
  if (!Number.isSafeInteger(hours) || !Number.isSafeInteger(minutes) || minutes >= MINUTES_PER_HOUR) return null;
  const totalMinutes = hours * MINUTES_PER_HOUR + minutes;
  return Number.isSafeInteger(totalMinutes) ? totalMinutes : null;
}

export const minutesToMilliseconds = (minutes: number) => minutes * MILLISECONDS_PER_MINUTE;

export function formatHoursAndMinutes(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return "";
  return `${Math.floor(minutes / MINUTES_PER_HOUR)},${String(minutes % MINUTES_PER_HOUR).padStart(2, "0")}`;
}

export function formatDuration(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 0) return "—";
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const remainder = minutes % MINUTES_PER_HOUR;
  return `${hours} ч ${remainder} мин`;
}

export function formatDurationBetween(start: unknown, end: unknown): string {
  const milliseconds = Date.parse(String(end)) - Date.parse(String(start));
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds % MILLISECONDS_PER_MINUTE !== 0) return "";
  return formatHoursAndMinutes(milliseconds / MILLISECONDS_PER_MINUTE);
}
