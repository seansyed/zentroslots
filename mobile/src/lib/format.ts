/**
 * Tiny formatting helpers. Intentionally no extra deps — avoids
 * shipping date-fns/Intl polyfills to RN.
 */

const DAY_NAMES_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTH_NAMES_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function parseDate(input: string | Date): Date {
  if (input instanceof Date) return input;
  return new Date(input);
}

export function formatTime(input: string | Date): string {
  const d = parseDate(input);
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  const mm = minutes.toString().padStart(2, "0");
  return `${hours}:${mm} ${ampm}`;
}

export function formatTimeRange(start: string | Date, end: string | Date): string {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

export function formatDateShort(input: string | Date): string {
  const d = parseDate(input);
  return `${MONTH_NAMES_SHORT[d.getMonth()]} ${d.getDate()}`;
}

export function formatDateLong(input: string | Date): string {
  const d = parseDate(input);
  return `${DAY_NAMES_LONG[d.getDay()]}, ${MONTH_NAMES_LONG[d.getMonth()]} ${d.getDate()}`;
}

export function formatDayMonth(input: string | Date): { day: string; month: string; weekday: string } {
  const d = parseDate(input);
  return {
    day: String(d.getDate()),
    month: MONTH_NAMES_SHORT[d.getMonth()],
    weekday: DAY_NAMES_SHORT[d.getDay()],
  };
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Returns "in 12m" / "5h ago" / "Today" / etc. */
export function formatRelative(input: string | Date): string {
  const d = parseDate(input);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const absMin = Math.abs(diff) / 60_000;
  const sign = diff >= 0 ? "in" : "ago";
  if (absMin < 1) return "just now";
  if (absMin < 60) return `${sign === "in" ? "in" : ""} ${Math.round(absMin)}m${sign === "ago" ? " ago" : ""}`.trim();
  const absH = absMin / 60;
  if (absH < 24) return `${sign === "in" ? "in" : ""} ${Math.round(absH)}h${sign === "ago" ? " ago" : ""}`.trim();
  if (isSameDay(d, now)) return "Today";
  const dayDiff = Math.floor(absH / 24);
  if (dayDiff === 1) return diff >= 0 ? "Tomorrow" : "Yesterday";
  return formatDateShort(d);
}

export function formatCurrencyCents(cents: number | null | undefined, currency = "USD"): string {
  if (typeof cents !== "number" || isNaN(cents)) return "—";
  const dollars = cents / 100;
  if (currency === "USD") {
    return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: dollars % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  return `${currency} ${dollars.toFixed(2)}`;
}

export function initialsFromName(name?: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return ((parts[0]![0] ?? "") + (parts[parts.length - 1]![0] ?? "")).toUpperCase();
}
