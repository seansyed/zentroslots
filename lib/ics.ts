/**
 * Minimal RFC 5545 iCalendar generator. No deps — emails attach this
 * as text/calendar so calendar apps offer "Add to calendar".
 */

type IcsArgs = {
  uid: string;                 // stable per booking, e.g. booking.id + domain
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;           // meet URL, address, etc.
  organizerEmail?: string;
  organizerName?: string;
  attendeeEmail?: string;
  attendeeName?: string;
  method?: "REQUEST" | "CANCEL";
};

function fmt(d: Date): string {
  // YYYYMMDDTHHmmssZ (UTC)
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

export function buildIcs(args: IcsArgs): string {
  const method = args.method ?? "REQUEST";
  const status = method === "CANCEL" ? "CANCELLED" : "CONFIRMED";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Scheduling SaaS//EN",
    `METHOD:${method}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${args.uid}`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(args.start)}`,
    `DTEND:${fmt(args.end)}`,
    `SUMMARY:${escape(args.summary)}`,
    `STATUS:${status}`,
    `SEQUENCE:${method === "CANCEL" ? 1 : 0}`,
  ];
  if (args.description) lines.push(`DESCRIPTION:${escape(args.description)}`);
  if (args.location) lines.push(`LOCATION:${escape(args.location)}`);
  if (args.organizerEmail) {
    lines.push(
      `ORGANIZER${args.organizerName ? `;CN=${escape(args.organizerName)}` : ""}:mailto:${args.organizerEmail}`
    );
  }
  if (args.attendeeEmail) {
    lines.push(
      `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${args.attendeeName ? `;CN=${escape(args.attendeeName)}` : ""}:mailto:${args.attendeeEmail}`
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  // RFC 5545: CRLF line endings, fold lines >75 octets (best-effort).
  return lines.join("\r\n") + "\r\n";
}
