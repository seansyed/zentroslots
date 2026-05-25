/**
 * Phase ICAL-1 — typed contracts for the universal ICS generator.
 *
 * RFC 5545 reference: https://datatracker.ietf.org/doc/html/rfc5545
 *
 * Design constraints honored across the ics/ module:
 *   • Pure TypeScript, zero npm dependencies — emails attach an
 *     in-memory string, no SDK initialization, no cold-start cost.
 *   • Apple Calendar–strict: VTIMEZONE is always emitted (Apple
 *     refuses to render local times without an embedded timezone
 *     definition, even when the DTSTART carries TZID), SEQUENCE
 *     increments on update, METHOD aligns between body + MIME
 *     Content-Type, and UID is stable across the booking's
 *     lifecycle so cancellations/updates target the same calendar
 *     entry the original invite created.
 *   • Defensive escaping — every text field passes through
 *     escape5545 before emission. Newline-injection is rejected at
 *     the boundary.
 *   • Line folding at 75 octets per RFC 5545 §3.1 (every continuation
 *     line begins with a leading space).
 *
 * This file defines ONLY types. The builders + emitters live in
 * sibling modules:
 *   - buildICSEvent.ts → low-level VEVENT + VTIMEZONE block
 *   - generateICS.ts   → high-level VCALENDAR wrapper
 *   - calendarLinks.ts → "Add to Google / Outlook / Yahoo" URL helpers
 *   - booking-ics.ts   → booking-domain adapter (consumed by the
 *                        email engine + the public download endpoint)
 */

/** iTIP method per RFC 5546. We use exactly two:
 *   - REQUEST  — new event or update (Apple, Outlook, Google treat
 *                an existing UID with a higher SEQUENCE as an update)
 *   - CANCEL   — withdrawal (calendar apps remove the event by UID)
 *
 * Other methods (PUBLISH, REPLY, ADD, REFRESH, COUNTER, DECLINE-
 * COUNTER) are intentionally NOT supported — they're not needed for
 * booking lifecycle and would expand the test surface without value. */
export type IcsMethod = "REQUEST" | "CANCEL";

/** VEVENT STATUS values we map onto. CONFIRMED for live bookings,
 *  CANCELLED for withdrawn ones, TENTATIVE reserved for pending-
 *  payment holds (future use; not currently emitted). */
export type IcsStatus = "CONFIRMED" | "CANCELLED" | "TENTATIVE";

/** Attendee participation status. Most invites are NEEDS-ACTION;
 *  internal-meeting attendees that are auto-confirmed (e.g. the
 *  organizer themselves) can use ACCEPTED. */
export type IcsAttendeeStatus =
  | "NEEDS-ACTION"
  | "ACCEPTED"
  | "DECLINED"
  | "TENTATIVE";

/** Single attendee record. Multiple attendees supported per VEVENT
 *  for group sessions + internal meetings. */
export type IcsAttendee = {
  email: string;
  name?: string | null;
  status?: IcsAttendeeStatus;
  /** Required vs optional. Defaults to REQ-PARTICIPANT. */
  role?: "REQ-PARTICIPANT" | "OPT-PARTICIPANT";
  /** Whether to ask for an RSVP. Defaults true for REQ, false for OPT. */
  rsvp?: boolean;
};

/** Alarm/reminder record per RFC 5545 §3.6.6. The ICS builder emits
 *  a VALARM with ACTION=DISPLAY and a TRIGGER computed from
 *  `minutesBefore`. Apple Calendar respects multiple VALARMs per
 *  VEVENT and dedupes by trigger offset. */
export type IcsAlarm = {
  /** Minutes BEFORE event start the alarm fires. Common values: 10,
   *  15, 30, 60, 1440 (24h). */
  minutesBefore: number;
  /** Optional override of the alarm description. Defaults to the
   *  event's SUMMARY. */
  description?: string;
};

/**
 * Booking shape passed to the ICS generator. Deliberately narrower
 * than the full `bookings` row — every field here is rendered into
 * the .ics, so a leak-by-default would be wrong.
 *
 * The booking-ics.ts adapter does the mapping from db rows; routes
 * NEVER instantiate this object themselves.
 */
export type IcsEvent = {
  /** Stable identifier for the calendar entry. Must NEVER change
   *  across the booking's lifecycle — Apple/Outlook key updates
   *  and cancellations off this value. Format:
   *  `<booking-or-event-id>@zentromeet`. */
  uid: string;

  /** Monotonically increasing integer. Bumped on every update. The
   *  email engine derives it from `bookings.updated_at` (epoch
   *  seconds capped to fit a 32-bit int) so any subsequent send
   *  always advances. RFC 5545 §3.8.7.4. */
  sequence: number;

  /** Event start (UTC instant). The builder converts to local
   *  wall-clock + emits with TZID. */
  startAt: Date;
  /** Event end (UTC instant). */
  endAt: Date;
  /** IANA timezone (e.g. "America/New_York", "UTC"). Used to emit
   *  the DTSTART/DTEND TZID parameter AND the inline VTIMEZONE
   *  definition. Apple Calendar mandates the VTIMEZONE block —
   *  without it the event renders in UTC. */
  timezone: string;

  /** Short event title. The escape5545 helper sanitizes — never
   *  pass user input straight through outside this type. */
  summary: string;
  /** Longer body text. May contain newlines; they get escaped to
   *  `\n` per RFC. */
  description?: string;
  /** Free-form location. Common values: meeting URL, physical
   *  address, room name. */
  location?: string;
  /** Optional external URL field surfaced in calendar UIs as
   *  "Open link" (Apple) or "URL" (Outlook). */
  url?: string;

  /** Event organizer (typically the staff member). RFC requires
   *  exactly one ORGANIZER per VEVENT. */
  organizer?: {
    email: string;
    name?: string | null;
  };

  /** Zero or more attendees. Booking emails attach an event with
   *  the customer as the sole attendee; internal meetings include
   *  the staff roster. */
  attendees?: IcsAttendee[];

  /** Reminders. When omitted, no VALARM is emitted. */
  alarms?: IcsAlarm[];

  /** iTIP method. Determines top-level METHOD line + Content-Type
   *  parameter on the email attachment. */
  method: IcsMethod;

  /** Optional explicit STATUS override. When omitted, derived from
   *  method (REQUEST → CONFIRMED, CANCEL → CANCELLED). */
  status?: IcsStatus;

  /** PRODID identifier emitted in the VCALENDAR header. Defaults
   *  to "-//ZentroMeet//Booking 1.0//EN". Override only for tests. */
  prodId?: string;
};

/** Result of generating a full VCALENDAR string. Includes the
 *  metadata callers need to construct an email attachment header. */
export type GeneratedIcs = {
  /** The full VCALENDAR document. CRLF line endings, line-folded at
   *  75 octets. Ready to attach OR serve as a response body. */
  body: string;
  /** Content-Type with the matching method parameter. */
  contentType: string;
  /** Suggested filename. Stable per booking so re-downloads land
   *  the same name. */
  filename: string;
  /** The iTIP method, surfaced so callers don't have to re-derive. */
  method: IcsMethod;
};
