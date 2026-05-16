import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildIcs } from "../lib/ics";

describe("ICS generator", () => {
  it("produces a valid VCALENDAR block", () => {
    const out = buildIcs({
      uid: "abc@example",
      start: new Date("2026-05-20T16:00:00Z"),
      end: new Date("2026-05-20T16:30:00Z"),
      summary: "Intro Call with Jamie",
      organizerEmail: "jamie@example.com",
      attendeeEmail: "client@example.com",
      method: "REQUEST",
    });
    assert.match(out, /^BEGIN:VCALENDAR/);
    assert.match(out, /END:VCALENDAR\r\n$/);
    assert.match(out, /UID:abc@example/);
    assert.match(out, /SUMMARY:Intro Call with Jamie/);
    assert.match(out, /DTSTART:20260520T160000Z/);
    assert.match(out, /DTEND:20260520T163000Z/);
    assert.match(out, /STATUS:CONFIRMED/);
    assert.match(out, /METHOD:REQUEST/);
    assert.match(out, /ORGANIZER:mailto:jamie@example.com/);
    assert.match(out, /ATTENDEE.*:mailto:client@example.com/);
  });

  it("escapes commas and semicolons in summary", () => {
    const out = buildIcs({
      uid: "x", start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-01T01:00:00Z"),
      summary: "Lunch; comma, here",
    });
    assert.match(out, /SUMMARY:Lunch\\; comma\\,/);
  });

  it("emits CANCELLED status for cancellation method", () => {
    const out = buildIcs({
      uid: "x", start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-01-01T01:00:00Z"),
      summary: "Bye", method: "CANCEL",
    });
    assert.match(out, /STATUS:CANCELLED/);
    assert.match(out, /METHOD:CANCEL/);
    assert.match(out, /SEQUENCE:1/);
  });
});
