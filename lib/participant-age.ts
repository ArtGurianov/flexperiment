export type ParticipantAge = {
  age: number;
  isMinor: boolean;
  requiresAdultAccompaniment: boolean;
};

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseBirthDate(value: string) {
  const match = datePattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day };
}

const localDateParts = (instant: string | Date, timeZone: string) => {
  const values = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(values.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
};

/** Computes age on the occurrence's local calendar date; Feb 29 uses Feb 28 in non-leap years. */
export function getParticipantAgeOnOccurrenceDate(dateOfBirth: string, occurrenceStartsAt: string | Date, occurrenceTimezone: string): ParticipantAge | null {
  const birth = parseBirthDate(dateOfBirth);
  if (!birth) return null;
  let occurrence: { year: number; month: number; day: number };
  try { occurrence = localDateParts(occurrenceStartsAt, occurrenceTimezone); } catch { return null; }
  const isLeapYear = new Date(Date.UTC(occurrence.year, 1, 29)).getUTCMonth() === 1;
  const anniversaryDay = birth.month === 2 && birth.day === 29 && !isLeapYear ? 28 : birth.day;
  let age = occurrence.year - birth.year;
  if (occurrence.month < birth.month || (occurrence.month === birth.month && occurrence.day < anniversaryDay)) age -= 1;
  if (age < 0) return null;
  return { age, isMinor: age < 18, requiresAdultAccompaniment: age < 14 };
}
