/**
 * Phase ICAL-1 — booking-domain adapter for the ICS generator.
 *
 * The low-level builders in generateICS.ts speak in pure `IcsEvent`
 * shapes — they know nothing about ZentroMeet's DB schema. This
 * module is the single place where booking rows, services, staff,
 * and tenant metadata get translated INTO that shape.
 *
 * Two callers use this:
 *   • lib/communications/engine.ts — when an automation email
 *     attaches an .ics (booking confirmed, rescheduled, cancelled).
 *   • app/api/public/calendar/[token]/route.ts — when a customer
 *     downloads the .ics directly from the confirmation page or
 *     re-downloads via the signed-token link in their email.
 *
 * Both code paths must produce IDENTICAL ICS bytes for the same
 * booking state — otherwise calendar apps will treat the downloaded
 * version as a different event and duplicate it in the user's
 * calendar. That's the entire point of stable UID + sequence-from-
 * updated_at + a single mapping function.
 */

import type { bookings, services, tenants, users } from "@/db/schema";
import type { IcsEvent, IcsMethod, GeneratedIcs } from "./types";
import { generateICS } from "./generateICS";

/** Trimmed projections — each route hands us only what we actually
 *  render. Avoids tight coupling to the full row shape (which
 *  varies as the schema grows). */
export type BookingForIcs = Pick<
  typeof bookings.$inferSelect,
  "id" | "startAt" | "endAt" | "clientEmail" | "clientName" | "notes" | "meetLink" | "updatedAt"
>;
export type ServiceForIcs = Pick<typeof services.$inferSelect, "name">;
export type StaffForIcs = Pick<
  typeof users.$inferSelect,
  "email" | "name" | "timezone"
>;
export type TenantForIcs = Pick<typeof tenants.$inferSelect, "name">;

export type BookingIcsArgs = {
  booking: BookingForIcs;
  service: ServiceForIcs;
  staff: StaffForIcs;
  tenant: TenantForIcs;
  method: IcsMethod;
  /** Optional reminders. Common pattern: [{minutesBefore: 1440}, {minutesBefore: 15}]
   *  for 24h + 15min. Suppressed on CANCEL events. */
  alarms?: { minutesBefore: number }[];
  /** Optional URL to surface in the calendar entry's "Open link"
   *  field (Apple) / "URL" property (Outlook). Typically the
   *  customer's view of their booking on the client portal. */
  url?: string;
};

/** Stable UID for a booking. Same value across every send + every
 *  download for the lifetime of the booking. Format follows RFC
 *  5545 §3.8.4.7 recommendation (uuid@domain). */
export function bookingUid(bookingId: string): string {
  return `${bookingId}@zentromeet`;
}

/** Derive a monotonic SEQUENCE from the booking's updated_at. Each
 *  reschedule/cancel/notes-update bumps updated_at, so the sequence
 *  always advances. We use epoch SECONDS modulo 2^31-1 so the value
 *  fits in a signed 32-bit integer (Outlook truncates higher).
 *
 *  The CONSEQUENCE: two updates within the same second produce the
 *  same SEQUENCE. In practice this is fine because the email engine
 *  serializes sends (and the public download is read-only), but the
 *  edge case is documented here for posterity. */
export function bookingSequence(updatedAt: Date): number {
  const seconds = Math.floor(updatedAt.getTime() / 1000);
  return seconds % 0x7fffffff;
}

/** Compose the human-readable summary line. Tenant name is included
 *  so a customer with multiple workspace bookings can distinguish
 *  them at a glance in their calendar list view. */
export function bookingSummary(args: {
  service: ServiceForIcs;
  staff: StaffForIcs;
  tenant: TenantForIcs;
}): string {
  return `${args.service.name} with ${args.staff.name}`;
}

/** Compose the longer description. We prepend the meeting URL on
 *  its own line (every calendar app renders URLs as clickable);
 *  follow with the customer's notes if any; close with the tenant
 *  brand footer for clarity in the customer's calendar app. */
export function bookingDescription(args: BookingIcsArgs): string {
  const lines: string[] = [];
  if (args.booking.meetLink) {
    lines.push(`Join: ${args.booking.meetLink}`);
    lines.push("");
  }
  if (args.booking.notes && args.booking.notes.trim().length > 0) {
    lines.push(args.booking.notes.trim());
    lines.push("");
  }
  lines.push(`Hosted by ${args.tenant.name} on ZentroMeet`);
  return lines.join("\n");
}

/** Map a booking + supporting rows to the IcsEvent shape, then call
 *  the generator. The single source of truth for "what does the ICS
 *  for booking X look like?" */
export function generateBookingIcs(args: BookingIcsArgs): GeneratedIcs {
  // Default to the staff's timezone (the slot was sold to the
  // customer in the staff's local time). Fall back to UTC if the
  // staff row somehow has no timezone (shouldn't happen — schema
  // default is "UTC" — but defensive).
  const timezone = (args.staff.timezone ?? "UTC").trim() || "UTC";

  const event: IcsEvent = {
    uid: bookingUid(args.booking.id),
    sequence: bookingSequence(args.booking.updatedAt),
    startAt: args.booking.startAt,
    endAt: args.booking.endAt,
    timezone,
    summary: bookingSummary(args),
    description: bookingDescription(args),
    // Prefer the meeting URL as the LOCATION (Apple renders it as
    // a clickable link in the event card). Falls back to omitting
    // the field entirely if there's no meeting link AND no future
    // physical-address column wires through.
    location: args.booking.meetLink ?? undefined,
    url: args.url,
    organizer: {
      email: args.staff.email,
      name: args.staff.name,
    },
    attendees: [
      {
        email: args.booking.clientEmail,
        name: args.booking.clientName,
        role: "REQ-PARTICIPANT",
        status: "NEEDS-ACTION",
        rsvp: true,
      },
    ],
    alarms: args.alarms,
    method: args.method,
  };

  return generateICS(event);
}
