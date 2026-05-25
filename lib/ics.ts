/**
 * @deprecated Phase ICAL-1 — this minimal ICS generator was replaced
 * by the universal generator at `lib/calendar/ics/*`. The new module
 * adds VTIMEZONE (required by Apple Calendar), 75-octet line folding
 * (required by Outlook), VALARM reminders, monotonic SEQUENCE
 * derivation, multi-attendee support, and a matching Content-Type
 * for CANCEL events.
 *
 * This shim re-exports a compatibility wrapper so any external
 * caller still depending on `import { buildIcs } from "@/lib/ics"`
 * keeps working. New code should import directly from
 * `@/lib/calendar/ics/generateICS` or `@/lib/calendar/ics/booking-ics`.
 *
 * The shim is intentionally THIN: it constructs an `IcsEvent` from
 * the legacy args, calls the new generator, and returns the body
 * string. The legacy shape lacked `timezone` + `sequence` so we
 * default both to safe values (UTC + 0). To get the upgraded output
 * (VTIMEZONE in the staff's locale + sequence-from-updated_at),
 * switch the import to `generateBookingIcs`.
 */

import { generateICS } from "./calendar/ics/generateICS";
import type { IcsEvent } from "./calendar/ics/types";

type LegacyIcsArgs = {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  organizerEmail?: string;
  organizerName?: string;
  attendeeEmail?: string;
  attendeeName?: string;
  method?: "REQUEST" | "CANCEL";
};

/** @deprecated use generateBookingIcs() or generateICS() directly. */
export function buildIcs(args: LegacyIcsArgs): string {
  const event: IcsEvent = {
    uid: args.uid,
    sequence: 0,
    startAt: args.start,
    endAt: args.end,
    timezone: "UTC",
    summary: args.summary,
    description: args.description,
    location: args.location,
    organizer: args.organizerEmail
      ? { email: args.organizerEmail, name: args.organizerName ?? null }
      : undefined,
    attendees: args.attendeeEmail
      ? [
          {
            email: args.attendeeEmail,
            name: args.attendeeName ?? null,
            role: "REQ-PARTICIPANT",
            status: "NEEDS-ACTION",
            rsvp: true,
          },
        ]
      : [],
    method: args.method ?? "REQUEST",
  };
  return generateICS(event).body;
}
