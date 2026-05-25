/**
 * @deprecated Phase ICAL-1 — the comprehensive suite for ICS lives at
 * tests/calendar-ics.test.ts. This file remains only to assert the
 * back-compat shim at lib/ics.ts continues to produce a parseable
 * VCALENDAR document for any external caller still depending on it.
 *
 * Format expectations match the NEW generator's output (VTIMEZONE +
 * TZID-qualified DTSTART, etc.), since the shim routes through it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildIcs } from "../lib/ics";

/**
 * Reverse RFC 5545 §3.1 line folding so substring regexes work
 * against properties (e.g. ATTENDEE with role+CN+mailto) that exceed
 * the 75-octet wire limit and get folded mid-content. The wire form
 * IS correctly folded — we just need an unfolded view for asserting.
 */
function unfold(body: string): string {
  return body.replace(/\r\n[ \t]/g, "");
}

describe("ICS shim (deprecated) — produces a valid VCALENDAR via the new generator", () => {
  it("emits header + VEVENT + matching method", () => {
    const raw = buildIcs({
      uid: "abc@example",
      start: new Date("2026-05-20T16:00:00Z"),
      end: new Date("2026-05-20T16:30:00Z"),
      summary: "Intro Call with Jamie",
      organizerEmail: "jamie@example.com",
      attendeeEmail: "client@example.com",
      method: "REQUEST",
    });
    // Header / footer assertions need the on-the-wire form (CRLF
    // terminators matter). The content-substring assertions need the
    // un-folded form because long lines like ATTENDEE get split.
    assert.match(raw, /^BEGIN:VCALENDAR/);
    assert.match(raw, /END:VCALENDAR\r\n$/);
    const out = unfold(raw);
    assert.match(out, /UID:abc@example/);
    assert.match(out, /SUMMARY:Intro Call with Jamie/);
    // New generator uses TZID-qualified DTSTART (legacy was UTC Z).
    assert.match(out, /DTSTART;TZID=UTC:20260520T160000/);
    assert.match(out, /DTEND;TZID=UTC:20260520T163000/);
    assert.match(out, /STATUS:CONFIRMED/);
    assert.match(out, /METHOD:REQUEST/);
    assert.match(out, /ORGANIZER:mailto:jamie@example.com/);
    assert.match(out, /ATTENDEE.*:mailto:client@example.com/);
  });

  it("escapes commas and semicolons in summary", () => {
    const out = buildIcs({
      uid: "x",
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-01T01:00:00Z"),
      summary: "Lunch; comma, here",
    });
    assert.match(out, /SUMMARY:Lunch\\; comma\\, here/);
  });

  it("emits CANCELLED status for cancellation method", () => {
    const out = buildIcs({
      uid: "x",
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-01T01:00:00Z"),
      summary: "Bye",
      method: "CANCEL",
    });
    assert.match(out, /STATUS:CANCELLED/);
    assert.match(out, /METHOD:CANCEL/);
  });
});
