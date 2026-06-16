import { formatInTimeZone } from "date-fns-tz";

/**
 * Server-authoritative appointment display labels.
 *
 * Mirrors lib/slots-display.ts: the mobile app cannot format an arbitrary IANA
 * zone on-device (Hermes ignores the Intl timeZone option), so the booking
 * endpoints attach pre-formatted labels and mobile renders them verbatim.
 *
 * The display timezone is the SIGNED-IN VIEWER's timezone — the same rule the
 * web dashboard uses (app/dashboard/appointments → user.timezone →
 * formatInTimeZone) — so the same user sees identical times on web and mobile.
 * The raw ISO-Z instants (startAt/endAt) are unchanged and remain the source of
 * truth for mutations.
 */
export type BookingLabels = {
  /** The viewer IANA tz the labels were formatted in. */
  timezone: string;
  /** Start time, e.g. "5:00 PM". */
  startLabel: string;
  /** End time, e.g. "5:30 PM". */
  endLabel: string;
  /** Start day in the viewer tz, e.g. "Saturday, May 16" (date-rollover safe). */
  startDayLabel: string;
  /** Zone abbreviation, e.g. "PDT". */
  tzAbbrev: string;
};

function safeTz(tz: string | null | undefined): string {
  return typeof tz === "string" && tz.trim().length > 0 ? tz.trim() : "UTC";
}

/**
 * Build viewer-tz display labels for one booking. Never throws on a bad tz —
 * falls back to UTC so a route can't 500 on a malformed users.timezone.
 */
export function buildBookingLabels(
  startIso: string | Date,
  endIso: string | Date,
  viewerTz: string | null | undefined,
): BookingLabels {
  const start = startIso instanceof Date ? startIso : new Date(startIso);
  const end = endIso instanceof Date ? endIso : new Date(endIso);
  let tz = safeTz(viewerTz);
  try {
    return {
      timezone: tz,
      startLabel: formatInTimeZone(start, tz, "h:mm a"),
      endLabel: formatInTimeZone(end, tz, "h:mm a"),
      startDayLabel: formatInTimeZone(start, tz, "EEEE, MMM d"),
      tzAbbrev: formatInTimeZone(start, tz, "zzz"),
    };
  } catch {
    tz = "UTC";
    return {
      timezone: tz,
      startLabel: formatInTimeZone(start, tz, "h:mm a"),
      endLabel: formatInTimeZone(end, tz, "h:mm a"),
      startDayLabel: formatInTimeZone(start, tz, "EEEE, MMM d"),
      tzAbbrev: formatInTimeZone(start, tz, "zzz"),
    };
  }
}
