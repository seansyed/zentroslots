/**
 * Phase ICAL-1 — "Add to Calendar" URL builders.
 *
 * Pure functions that build click-through URLs for the major web
 * calendar providers. No I/O, no React imports — usable from
 * server components, client components, AND the email engine
 * (e.g. to embed "Add to Google" links inside the HTML body).
 *
 * Provider URL formats:
 *   Google      https://calendar.google.com/calendar/render?action=TEMPLATE&...
 *   Outlook.com https://outlook.live.com/calendar/0/deeplink/compose?...
 *   Office 365  https://outlook.office.com/calendar/0/deeplink/compose?...
 *   Yahoo       https://calendar.yahoo.com/?v=60&...
 *   Apple/ICS   our own signed-token download endpoint
 *
 * Apple Calendar has NO web-add deep link — the standard pattern is
 * "download an .ics file and let Apple Calendar's URL handler open
 * it" (every Mac + iPhone registers a handler for .ics out of the
 * box). So the "Add to Apple Calendar" button is really an .ics
 * download. Yahoo also lacks a documented modern deep link with
 * timezone — we use the v=60 quick-add form which is widely
 * referenced but imperfect for all-day events.
 */

export type AddToCalendarArgs = {
  /** Event title shown in the calendar app. */
  title: string;
  /** UTC start instant. */
  startAt: Date;
  /** UTC end instant. */
  endAt: Date;
  /** Optional body text — usually the meeting URL + notes. */
  description?: string;
  /** Optional venue / address / meeting URL. */
  location?: string;
};

// ─── Time helpers ─────────────────────────────────────────────────────

/** RFC 5545 UTC format: YYYYMMDDTHHMMSSZ. Used by Google + Yahoo. */
function utcCompact(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** ISO 8601 with offset. Used by Outlook deep links. */
function iso(d: Date): string {
  return d.toISOString();
}

// ─── Google Calendar ──────────────────────────────────────────────────

/** Build a Google Calendar "Add Event" URL. Opens in the user's
 *  signed-in Google account with the event prefilled — they click
 *  Save to commit it.
 *
 *  Note: `dates` MUST be the UTC compact form `<start>/<end>` with
 *  no timezone parameter (Google ignores `ctz` for TEMPLATE links).
 *  Customer's calendar timezone is whatever they have configured. */
export function generateGoogleCalendarUrl(args: AddToCalendarArgs): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: args.title,
    dates: `${utcCompact(args.startAt)}/${utcCompact(args.endAt)}`,
  });
  if (args.description) params.set("details", args.description);
  if (args.location) params.set("location", args.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ─── Microsoft Outlook ────────────────────────────────────────────────

/** Build an Outlook.com / Office 365 deep link. The `path` +
 *  `rru=addevent` combo is the documented MS pattern for both
 *  outlook.live.com and outlook.office.com (the host changes;
 *  query string is identical). We default to outlook.live.com
 *  (personal accounts); office.com works the same way and a future
 *  flag could swap it.
 *
 *  Outlook deep links take ISO 8601 strings with offsets — Outlook
 *  re-resolves to the user's calendar timezone on open. */
export function generateOutlookCalendarUrl(
  args: AddToCalendarArgs,
  opts: { variant?: "live" | "office" } = {},
): string {
  const variant = opts.variant ?? "live";
  const host =
    variant === "office"
      ? "https://outlook.office.com"
      : "https://outlook.live.com";
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    startdt: iso(args.startAt),
    enddt: iso(args.endAt),
    subject: args.title,
  });
  if (args.description) params.set("body", args.description);
  if (args.location) params.set("location", args.location);
  return `${host}/calendar/0/deeplink/compose?${params.toString()}`;
}

// ─── Yahoo Calendar ───────────────────────────────────────────────────

/** Build a Yahoo Calendar quick-add URL. The Yahoo format uses
 *  `st` (start) + `et` (end) in the UTC compact form, plus `v=60`
 *  (version) + `title` + `desc` + `in_loc`. Yahoo's calendar UI is
 *  much less polished than Google/MS but still has users. */
export function generateYahooCalendarUrl(args: AddToCalendarArgs): string {
  const params = new URLSearchParams({
    v: "60",
    title: args.title,
    st: utcCompact(args.startAt),
    et: utcCompact(args.endAt),
  });
  if (args.description) params.set("desc", args.description);
  if (args.location) params.set("in_loc", args.location);
  return `https://calendar.yahoo.com/?${params.toString()}`;
}

// ─── ICS download (our own endpoint) ──────────────────────────────────

/** Resolve the absolute URL for the signed-token .ics download
 *  endpoint. Honors APP_BASE_URL (the same env var
 *  buildBookingActionUrl uses) so the same link works in any env. */
export function generateICSDownloadUrl(token: string): string {
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(
    /\/+$/,
    "",
  );
  return `${base}/api/public/calendar/${encodeURIComponent(token)}`;
}

// ─── Bundled helper ───────────────────────────────────────────────────

/** Convenience — build all four URLs at once. Useful for both the
 *  email engine (inline links in the HTML body) and the client
 *  confirmation page (button row). */
export function buildAllAddToCalendarLinks(
  args: AddToCalendarArgs,
  icsToken: string | null,
): {
  google: string;
  outlook: string;
  yahoo: string;
  ics: string | null;
} {
  return {
    google: generateGoogleCalendarUrl(args),
    outlook: generateOutlookCalendarUrl(args),
    yahoo: generateYahooCalendarUrl(args),
    ics: icsToken ? generateICSDownloadUrl(icsToken) : null,
  };
}
