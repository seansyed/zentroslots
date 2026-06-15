/**
 * Date helpers — pure, dependency-free, Hermes-safe (unit-testable under node).
 *
 * IMPORTANT (Hermes): do NOT use `Intl.DateTimeFormat({ timeZone })` for
 * formatting a picked calendar day. Hermes (RN 0.76 release) does not honor
 * the `timeZone` option, so the previous `isoDateInZone` silently fell back
 * to `date.toISOString()` (UTC) — which, for operators EAST of UTC, produced
 * the PREVIOUS calendar day and fetched availability for the wrong (often
 * closed) date. A calendar cell already represents the intended Y-M-D, so we
 * format from its LOCAL components and send that literal date; the backend
 * interprets it in the staff/tenant timezone.
 */

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" from a Date's LOCAL components (no timezone conversion). */
export function isoDateLocal(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight copy of a date (strips time). */
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** First day (local midnight) of the month containing d. */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Add n months, anchored to the first of the month. */
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** True if `a`'s calendar day is strictly before `b`'s (ignores time). */
export function isBeforeDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() < startOfDay(b).getTime();
}

/** "June 2026" style label. Uses month/year only — no timezone, Hermes-safe. */
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

const WEEKDAYS_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
/** "Friday, Jun 20" — manual format, Hermes-safe (no Intl options). */
export function dayLabel(d: Date): string {
  return `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/**
 * 6×7 calendar matrix for the month containing `viewMonth`, padded with the
 * surrounding days so each row is a full week. `weekStartsOn` 0=Sunday (US
 * default). Each cell is a local-midnight Date; `inMonth` marks the focal
 * month. Always 6 rows so the grid height is stable across months.
 */
export function monthMatrix(
  viewMonth: Date,
  weekStartsOn: 0 | 1 = 0,
): { date: Date; inMonth: boolean }[][] {
  const first = startOfMonth(viewMonth);
  const firstWeekday = first.getDay(); // 0=Sun..6=Sat
  const lead = (firstWeekday - weekStartsOn + 7) % 7;
  const gridStart = addDays(first, -lead);
  const weeks: { date: Date; inMonth: boolean }[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: { date: Date; inMonth: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const cell = addDays(gridStart, w * 7 + d);
      row.push({ date: cell, inMonth: cell.getMonth() === first.getMonth() });
    }
    weeks.push(row);
  }
  return weeks;
}

/** Weekday header labels honoring weekStartsOn. */
export function weekdayLabels(weekStartsOn: 0 | 1 = 0): string[] {
  const base = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return [...base.slice(weekStartsOn), ...base.slice(0, weekStartsOn)];
}
