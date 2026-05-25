/**
 * Phase ICAL-1 — low-level VEVENT + VTIMEZONE block builder.
 *
 * Returns an ARRAY of property lines (not yet folded, not yet
 * VCALENDAR-wrapped). generateICS.ts assembles them into the final
 * document; tests reach this layer to assert individual properties
 * without parsing a full VCALENDAR.
 *
 * Pure function — no I/O, no DB calls, no globals. Deterministic
 * output for deterministic input (the DTSTAMP is the only field that
 * varies, and callers can override it for snapshot testing).
 */

import type {
  IcsAlarm,
  IcsAttendee,
  IcsEvent,
  IcsStatus,
} from "./types";

// ─── Escaping (RFC 5545 §3.3.11 TEXT) ─────────────────────────────────

/** Escape a TEXT-typed property value. Order matters: backslash
 *  FIRST so we don't re-escape the escapes we add for ;, ,, and
 *  newlines. Also rejects raw CR which would break the CRLF line
 *  format — we collapse \r\n to \n then escape \n to \\n. */
export function escape5545(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** Escape a CAL-ADDRESS parameter value (e.g. CN= attendee name).
 *  Per RFC 5545 §3.2 parameter values containing colon, semicolon,
 *  or double-quote MUST be wrapped in DQUOTE. We also strip CR/LF
 *  defensively. */
export function escapeParamValue(input: string): string {
  const clean = input.replace(/[\r\n]/g, " ").trim();
  if (/[":;,]/.test(clean)) {
    // RFC 5545 forbids DQUOTE inside a DQUOTE-wrapped param value;
    // strip them to keep the wrapper valid.
    return `"${clean.replace(/"/g, "")}"`;
  }
  return clean;
}

// ─── Time formatting ──────────────────────────────────────────────────

/** Format a Date as RFC 5545 UTC: YYYYMMDDTHHMMSSZ. */
export function formatUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Format a Date as RFC 5545 local-time (no Z suffix):
 *  YYYYMMDDTHHMMSS — used inside a TZID-qualified property. The
 *  resolved local time is computed via Intl with the supplied
 *  IANA timezone, which handles DST + offset transitions correctly
 *  (Apple Calendar will then re-resolve against the inline
 *  VTIMEZONE definition). */
export function formatLocal(d: Date, timezone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(d).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    },
    {},
  );
  // Intl returns hour="24" for midnight in some locales — normalize.
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}${parts.month}${parts.day}T${hour}${parts.minute}${parts.second}`;
}

// ─── VTIMEZONE emission ───────────────────────────────────────────────
//
// Apple Calendar (macOS + iOS) REFUSES to render local times unless
// the .ics carries a VTIMEZONE definition for every TZID referenced
// in DTSTART/DTEND — even when the TZID is a well-known IANA value.
// We emit a MINIMAL but VALID VTIMEZONE that defines the current
// standard/daylight offsets at the event time. This is the
// industry-standard "good enough" approach (Google's gcal emits
// similar minimal blocks).
//
// Full DST-rule emission (RRULE inside STANDARD/DAYLIGHT) would
// require a tzdata table; the minimal form below works because
// Apple/Outlook only need the offset MAP for the dates referenced
// in the event, not the entire historical/future rule set.

function offsetMinutes(d: Date, timezone: string): number {
  // Compute the timezone offset (in minutes) by formatting the date
  // in BOTH the target timezone AND UTC, then taking the diff. This
  // sidesteps Node's lack of a direct getTimezoneOffset(tz) API.
  const local = new Date(d.toLocaleString("en-US", { timeZone: timezone }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local.getTime() - utc.getTime()) / 60_000);
}

function formatUtcOffset(minutes: number): string {
  // ±HHMM per RFC 5545. UTC = +0000.
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}`;
}

/** Build the VTIMEZONE block lines for the given IANA timezone, using
 *  the offset at `referenceDate` for the active sub-block. We emit
 *  BOTH a STANDARD and DAYLIGHT sub-block when the timezone observes
 *  DST and they differ at this reference; otherwise STANDARD only. */
export function buildVTimezone(timezone: string, referenceDate: Date): string[] {
  // For UTC we still emit a minimal VTIMEZONE (some Outlook builds
  // reject events with TZID=UTC without a definition).
  const refOffset = offsetMinutes(referenceDate, timezone);

  // Find DST opposite by sampling Jan + Jul of the reference year.
  const year = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
  }).format(referenceDate);
  const yr = parseInt(year, 10);
  const janOffset = offsetMinutes(new Date(Date.UTC(yr, 0, 15, 12)), timezone);
  const julOffset = offsetMinutes(new Date(Date.UTC(yr, 6, 15, 12)), timezone);
  const observesDst = janOffset !== julOffset;

  // STANDARD = the lower-offset half (winter); DAYLIGHT = higher-offset.
  const standardOffset = Math.min(janOffset, julOffset);
  const daylightOffset = Math.max(janOffset, julOffset);

  const lines: string[] = [
    "BEGIN:VTIMEZONE",
    `TZID:${timezone}`,
    "BEGIN:STANDARD",
    // DTSTART within a VTIMEZONE sub-block is just an anchor — the
    // year doesn't have to match the event. 19710101 is the common
    // industry default for "before time started observing this rule".
    "DTSTART:19710101T000000",
    `TZOFFSETFROM:${formatUtcOffset(observesDst ? daylightOffset : refOffset)}`,
    `TZOFFSETTO:${formatUtcOffset(standardOffset)}`,
    "TZNAME:STANDARD",
    "END:STANDARD",
  ];
  if (observesDst) {
    lines.push(
      "BEGIN:DAYLIGHT",
      "DTSTART:19710101T000000",
      `TZOFFSETFROM:${formatUtcOffset(standardOffset)}`,
      `TZOFFSETTO:${formatUtcOffset(daylightOffset)}`,
      "TZNAME:DAYLIGHT",
      "END:DAYLIGHT",
    );
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

// ─── Attendee + alarm emission ────────────────────────────────────────

function buildAttendeeLine(a: IcsAttendee): string {
  const role = a.role ?? "REQ-PARTICIPANT";
  const partstat = a.status ?? "NEEDS-ACTION";
  const rsvp = a.rsvp ?? role === "REQ-PARTICIPANT";
  const params: string[] = [
    `ROLE=${role}`,
    `PARTSTAT=${partstat}`,
    `RSVP=${rsvp ? "TRUE" : "FALSE"}`,
  ];
  if (a.name && a.name.trim()) {
    params.push(`CN=${escapeParamValue(a.name)}`);
  }
  return `ATTENDEE;${params.join(";")}:mailto:${a.email}`;
}

function buildAlarmLines(a: IcsAlarm, summary: string): string[] {
  // TRIGGER:-PT15M means "15 minutes BEFORE the event start". RFC
  // 5545 §3.8.6.3. We clamp negative inputs to 0 (alarms in the
  // future of the event would be silently ignored by most clients).
  const minutes = Math.max(0, Math.round(a.minutesBefore));
  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `TRIGGER:-PT${minutes}M`,
    `DESCRIPTION:${escape5545(a.description ?? summary)}`,
    "END:VALARM",
  ];
}

// ─── VEVENT block ─────────────────────────────────────────────────────

export type BuildOpts = {
  /** Override DTSTAMP for snapshot testing. Default = now. */
  now?: Date;
};

/** Build the lines for a single VEVENT block, INCLUDING the
 *  preceding VTIMEZONE block. Returned as an unfolded line array so
 *  the caller can assemble multiple VEVENTs into one VCALENDAR (we
 *  don't currently emit multiple-event documents, but the API
 *  supports it for future use). */
export function buildICSEvent(event: IcsEvent, opts: BuildOpts = {}): string[] {
  const now = opts.now ?? new Date();
  const status: IcsStatus =
    event.status ?? (event.method === "CANCEL" ? "CANCELLED" : "CONFIRMED");

  const sequence = Math.max(0, Math.floor(event.sequence));

  // VTIMEZONE first — Apple parses sub-blocks in order, and a
  // forward reference to TZID before its definition is technically
  // legal but trips some older Outlook builds.
  const tzLines = buildVTimezone(event.timezone, event.startAt);

  const vevent: string[] = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtc(now)}`,
    `SEQUENCE:${sequence}`,
    `STATUS:${status}`,
    // Per RFC 5545, TZID-qualified DTSTART uses local time (no Z).
    `DTSTART;TZID=${event.timezone}:${formatLocal(event.startAt, event.timezone)}`,
    `DTEND;TZID=${event.timezone}:${formatLocal(event.endAt, event.timezone)}`,
    `SUMMARY:${escape5545(event.summary)}`,
  ];

  if (event.description) {
    vevent.push(`DESCRIPTION:${escape5545(event.description)}`);
  }
  if (event.location) {
    vevent.push(`LOCATION:${escape5545(event.location)}`);
  }
  if (event.url) {
    // URL is NOT escaped per §3.8.4.6 — emit as-is. We do strip CR/
    // LF defensively in case caller passed pasted text.
    vevent.push(`URL:${event.url.replace(/[\r\n]/g, "")}`);
  }
  if (event.organizer?.email) {
    const cn = event.organizer.name
      ? `;CN=${escapeParamValue(event.organizer.name)}`
      : "";
    vevent.push(`ORGANIZER${cn}:mailto:${event.organizer.email}`);
  }
  if (event.attendees) {
    for (const att of event.attendees) {
      vevent.push(buildAttendeeLine(att));
    }
  }
  // Cancellations strip alarms — calendar apps shouldn't fire a
  // reminder for an event the user is being told is removed.
  if (event.method !== "CANCEL" && event.alarms) {
    for (const alarm of event.alarms) {
      vevent.push(...buildAlarmLines(alarm, event.summary));
    }
  }
  vevent.push("END:VEVENT");

  return [...tzLines, ...vevent];
}
