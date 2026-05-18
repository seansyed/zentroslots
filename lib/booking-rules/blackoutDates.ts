/**
 * Blackout date check.
 *
 * Compares the booking's start date (in the staff's / tenant's TZ —
 * caller passes the resolved date string in YYYY-MM-DD form) against
 * the configured blackout list. Pure — no DB.
 *
 * Returns the matched date when blocked, null when allowed.
 */

export function checkBlackoutDate(args: {
  bookingDate: string; // "YYYY-MM-DD"
  blackoutDates: string[];
}): string | null {
  if (!Array.isArray(args.blackoutDates) || args.blackoutDates.length === 0) return null;
  // Normalize once — admins might paste with surrounding whitespace.
  const target = args.bookingDate.trim();
  for (const raw of args.blackoutDates) {
    if (typeof raw !== "string") continue;
    if (raw.trim() === target) return raw.trim();
  }
  return null;
}

/**
 * Format a Date in a target timezone as a YYYY-MM-DD string. Re-used
 * by the public flow + the validator so both agree on "what date is
 * this booking".
 */
export function dateInTimezone(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
