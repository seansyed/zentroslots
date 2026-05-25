/**
 * Phase ICAL-2 — emit the VCALENDAR document for a staff subscription
 * feed.
 *
 * Output shape (Apple Calendar + Outlook + Google validated):
 *
 *   BEGIN:VCALENDAR
 *   VERSION:2.0
 *   PRODID:-//ZentroMeet//Staff Feed 1.0//EN
 *   METHOD:PUBLISH
 *   CALSCALE:GREGORIAN
 *   X-WR-CALNAME:<staff name> — ZentroMeet
 *   X-WR-TIMEZONE:<staff timezone>
 *   X-PUBLISHED-TTL:PT1H
 *   REFRESH-INTERVAL;VALUE=DURATION:PT1H
 *   <one VTIMEZONE per unique TZID>
 *   <one VEVENT per FeedEvent — no attendees, no alarms>
 *   END:VCALENDAR
 *
 * Why METHOD:PUBLISH (not REQUEST):
 *   • RFC 5546 §3.2.2: PUBLISH is "post a calendar entry to one or
 *     more calendar users", with NO expectation of reply. Exactly
 *     the right semantic for a one-way subscription.
 *   • REQUEST in a subscription feed would trigger Apple Calendar
 *     to surface "Accept / Decline" buttons that go nowhere — bad
 *     UX, and would imply an RSVP path we don't have.
 *
 * Why no VALARM blocks:
 *   • Apple Calendar honors a per-subscription "Default Alert" the
 *     user sets in Settings. Emitting our own would override that
 *     preference and produce duplicate notifications (one from us,
 *     one from the user's default).
 *
 * Why no ATTENDEE lines:
 *   • Per spec — feeds are one-way. Including an ATTENDEE block
 *     would let some clients surface bogus RSVP UI.
 *
 * Why X-WR-CALNAME / X-WR-TIMEZONE / X-PUBLISHED-TTL:
 *   • X-WR-CALNAME — Apple Calendar shows this as the subscription's
 *     display name in the sidebar. Without it the calendar inherits
 *     the URL path as its name (ugly).
 *   • X-WR-TIMEZONE — hint for clients that don't fully respect
 *     per-event TZID (e.g. some Android calendar apps).
 *   • X-PUBLISHED-TTL + REFRESH-INTERVAL — non-standard but widely
 *     supported hint that "you only need to re-poll every hour".
 *     Reduces server load.
 */

import crypto from "node:crypto";

import {
  buildVTimezone,
  escape5545,
  formatLocal,
  formatUtc,
} from "@/lib/calendar/ics/buildICSEvent";
import { foldLine } from "@/lib/calendar/ics/generateICS";
import { buildStaffFeedEvents } from "./buildFeedEvents";
import type { FeedEvent, GeneratedFeed } from "./types";

const PRODID = "-//ZentroMeet//Staff Feed 1.0//EN";

/** Slugify a string for safe filename emission. */
function filenameSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "staff";
}

/** Build the VEVENT lines for a single feed event. No method, no
 *  attendees, no alarms — see module header for the rationale. */
function buildFeedVEvent(event: FeedEvent, dtstamp: Date): string[] {
  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtc(dtstamp)}`,
    `SEQUENCE:${Math.max(0, Math.floor(event.sequence))}`,
    `LAST-MODIFIED:${formatUtc(event.lastModified)}`,
    "STATUS:CONFIRMED",
    `DTSTART;TZID=${event.timezone}:${formatLocal(event.startAt, event.timezone)}`,
    `DTEND;TZID=${event.timezone}:${formatLocal(event.endAt, event.timezone)}`,
    `SUMMARY:${escape5545(event.summary)}`,
  ];
  if (event.description) {
    lines.push(`DESCRIPTION:${escape5545(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escape5545(event.location)}`);
  }
  if (event.organizer?.email) {
    const cn = event.organizer.name
      ? `;CN=${escape5545(event.organizer.name)}`
      : "";
    // Note: organizer is informational only in PUBLISH context.
    lines.push(`ORGANIZER${cn}:mailto:${event.organizer.email}`);
  }
  // Apple Calendar uses TRANSP:OPAQUE to mark the event as "busy"
  // for downstream availability checks. Subscriptions inherit per-
  // calendar busy/free semantics; we set it explicitly so it survives
  // re-render across all clients.
  lines.push("TRANSP:OPAQUE");
  lines.push("END:VEVENT");
  return lines;
}

/** Compose the full VCALENDAR document + cache metadata. */
export async function generateStaffFeed(args: {
  tenantId: string;
  staffUserId: string;
  /** Override `now` for deterministic tests. */
  now?: Date;
}): Promise<GeneratedFeed> {
  const now = args.now ?? new Date();

  const { events, staffTimezone, tenantName, staffName } =
    await buildStaffFeedEvents(
      { tenantId: args.tenantId, staffUserId: args.staffUserId },
      { now },
    );

  // ─── VTIMEZONE blocks ───────────────────────────────────────────
  // Emit one VTIMEZONE per unique TZID. Most feeds will only have
  // the staff's own timezone, but if we ever surface cross-tz events
  // (TBD) this scales correctly.
  const uniqueTzs = new Set<string>();
  for (const e of events) uniqueTzs.add(e.timezone);
  if (uniqueTzs.size === 0) uniqueTzs.add(staffTimezone || "UTC");

  const tzBlocks: string[] = [];
  for (const tz of uniqueTzs) {
    tzBlocks.push(...buildVTimezone(tz, now));
  }

  // ─── VEVENT blocks ──────────────────────────────────────────────
  const veventBlocks: string[] = [];
  for (const e of events) {
    veventBlocks.push(...buildFeedVEvent(e, now));
  }

  // ─── VCALENDAR wrapper ──────────────────────────────────────────
  const calName = staffName
    ? `${staffName} — ${tenantName}`
    : `${tenantName} Staff Calendar`;

  const headerLines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "METHOD:PUBLISH",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escape5545(calName)}`,
    `X-WR-TIMEZONE:${staffTimezone}`,
    `X-WR-CALDESC:${escape5545(
      `Your ZentroMeet bookings, blocked time, and group sessions. ` +
        `One-way subscription feed — does not affect availability sync. ` +
        `For two-way busy-time sync, connect Google or Microsoft Calendar.`,
    )}`,
    // Refresh cadence hint. Apple respects this; clients that don't
    // ignore it harmlessly.
    "X-PUBLISHED-TTL:PT1H",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
  ];

  const footerLines: string[] = ["END:VCALENDAR"];

  const allLines = [
    ...headerLines,
    ...tzBlocks,
    ...veventBlocks,
    ...footerLines,
  ];

  // Fold at 75 octets + CRLF terminate.
  const body = allLines.map(foldLine).join("\r\n") + "\r\n";

  // ─── Cache metadata ─────────────────────────────────────────────
  // ETag = sha256 of the body, truncated to 16 hex chars (64 bits is
  // plenty to detect any content change). Quoted per RFC 7232 §2.3.
  const etagHex = crypto
    .createHash("sha256")
    .update(body, "utf8")
    .digest("hex")
    .slice(0, 16);
  const etag = `"${etagHex}"`;

  // Last-Modified = max lastModified across events, or now if the
  // feed is empty. Apple uses this for If-Modified-Since gating.
  let lastModified = now;
  for (const e of events) {
    if (e.lastModified > lastModified) lastModified = e.lastModified;
  }

  return {
    body,
    contentType: "text/calendar; charset=utf-8; method=PUBLISH",
    filename: `zentromeet-${filenameSlug(staffName || "staff")}.ics`,
    etag,
    lastModified,
    eventCount: events.length,
  };
}
