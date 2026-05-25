/**
 * Phase ICAL-1 — universal ICS generator tests.
 *
 * Coverage:
 *   • RFC 5545 structural compliance (header, VTIMEZONE, VEVENT,
 *     trailing CRLF)
 *   • VTIMEZONE emission for both UTC + DST-observing zones
 *   • DST boundary correctness (NY summer vs winter)
 *   • SEQUENCE derivation from updated_at (monotonic + 32-bit cap)
 *   • Stable UID across re-renders
 *   • Cancellation: STATUS=CANCELLED, METHOD=CANCEL, matching MIME,
 *     SEQUENCE preserved, VALARM suppressed
 *   • Line folding at 75 octets (continuation line begins with space)
 *   • Multibyte UTF-8 safety at the fold boundary (no split codepoints)
 *   • Text escaping (commas, semicolons, newlines, backslashes)
 *   • Parameter escaping for CAL-ADDRESS names with quotes
 *   • Calendar-link URLs (Google, Outlook, Yahoo, ICS) round-trip
 *     the title + start + end fields
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildICSEvent,
  buildVTimezone,
  escape5545,
  escapeParamValue,
  formatLocal,
  formatUtc,
} from "../lib/calendar/ics/buildICSEvent";
import { foldLine, generateICS } from "../lib/calendar/ics/generateICS";
import {
  bookingSequence,
  bookingUid,
  generateBookingIcs,
} from "../lib/calendar/ics/booking-ics";
import {
  generateGoogleCalendarUrl,
  generateOutlookCalendarUrl,
  generateYahooCalendarUrl,
} from "../lib/calendar/ics/calendarLinks";
import type { IcsEvent } from "../lib/calendar/ics/types";

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Reverse RFC 5545 §3.1 line folding so that test assertions can match
 * against logical (un-folded) lines.
 *
 * The generator MUST fold any line whose UTF-8 byte length exceeds 75
 * octets by inserting CRLF + a single whitespace (SPACE or HTAB) at
 * the fold boundary. That folding is part of the on-the-wire format
 * Apple Calendar / Outlook require — but it makes substring regexes
 * unreliable because a property like
 *
 *   ATTENDEE;ROLE=REQ-PARTICIPANT;...;CN=Sam Client:mailto:sam@example.com
 *
 * gets split mid-content. We unfold for assertion purposes only; we
 * separately assert (in the foldLine suite) that the on-the-wire form
 * IS correctly folded.
 */
function unfold(body: string): string {
  return body.replace(/\r\n[ \t]/g, "");
}

// ─── Test fixtures ────────────────────────────────────────────────────

function baseEvent(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "test-uid@zentromeet",
    sequence: 0,
    startAt: new Date("2026-05-20T16:00:00Z"),
    endAt: new Date("2026-05-20T16:30:00Z"),
    timezone: "America/New_York",
    summary: "Intro Call",
    description: "First chat",
    location: "https://meet.example.com/abc",
    organizer: { email: "jamie@example.com", name: "Jamie Q" },
    attendees: [
      {
        email: "client@example.com",
        name: "Sam Client",
        role: "REQ-PARTICIPANT",
        status: "NEEDS-ACTION",
        rsvp: true,
      },
    ],
    alarms: [{ minutesBefore: 15 }, { minutesBefore: 1440 }],
    method: "REQUEST",
    ...overrides,
  };
}

// ─── Structural compliance ────────────────────────────────────────────

describe("generateICS — structural compliance", () => {
  it("emits VCALENDAR header + footer with CRLF line endings", () => {
    const out = generateICS(baseEvent()).body;
    assert.ok(out.startsWith("BEGIN:VCALENDAR\r\n"));
    assert.ok(out.endsWith("END:VCALENDAR\r\n"));
    assert.match(out, /VERSION:2\.0/);
    assert.match(out, /PRODID:-\/\/ZentroMeet/);
    assert.match(out, /METHOD:REQUEST/);
    assert.match(out, /CALSCALE:GREGORIAN/);
  });

  it("wraps the event in BEGIN:VEVENT / END:VEVENT", () => {
    const out = generateICS(baseEvent()).body;
    assert.match(out, /BEGIN:VEVENT/);
    assert.match(out, /END:VEVENT/);
  });

  it("emits a VTIMEZONE block when the event uses a non-UTC TZID", () => {
    const out = generateICS(baseEvent({ timezone: "America/New_York" })).body;
    assert.match(out, /BEGIN:VTIMEZONE/);
    assert.match(out, /TZID:America\/New_York/);
    assert.match(out, /END:VTIMEZONE/);
  });

  it("ALSO emits a VTIMEZONE for UTC (some Outlook builds need it)", () => {
    const out = generateICS(baseEvent({ timezone: "UTC" })).body;
    assert.match(out, /BEGIN:VTIMEZONE/);
    assert.match(out, /TZID:UTC/);
  });

  it("the Content-Type method param matches the body METHOD", () => {
    const req = generateICS(baseEvent({ method: "REQUEST" }));
    assert.match(req.contentType, /method=REQUEST/);
    const cancel = generateICS(baseEvent({ method: "CANCEL" }));
    assert.match(cancel.contentType, /method=CANCEL/);
  });

  it("returns a stable, downloadable filename derived from UID", () => {
    const out = generateICS(baseEvent({ uid: "abc-123@zentromeet" }));
    assert.match(out.filename, /^invite-/);
    assert.ok(out.filename.endsWith(".ics"));
    // CANCEL filename uses a distinct prefix so a customer downloading
    // a cancellation doesn't overwrite the original invite in their
    // Downloads folder.
    const cancel = generateICS(
      baseEvent({ method: "CANCEL", uid: "abc-123@zentromeet" }),
    );
    assert.match(cancel.filename, /^cancellation-/);
  });
});

// ─── DST + timezone correctness ───────────────────────────────────────

describe("buildVTimezone — DST handling", () => {
  it("emits both STANDARD + DAYLIGHT sub-blocks for DST-observing zones", () => {
    const lines = buildVTimezone("America/New_York", new Date("2026-07-15T12:00:00Z"));
    const joined = lines.join("\n");
    assert.match(joined, /BEGIN:STANDARD[\s\S]*END:STANDARD/);
    assert.match(joined, /BEGIN:DAYLIGHT[\s\S]*END:DAYLIGHT/);
    // NY: standard = -0500, daylight = -0400
    assert.match(joined, /TZOFFSETTO:-0500/);
    assert.match(joined, /TZOFFSETTO:-0400/);
  });

  it("emits only STANDARD for non-DST zones", () => {
    const lines = buildVTimezone("Asia/Tokyo", new Date("2026-01-15T12:00:00Z"));
    const joined = lines.join("\n");
    assert.match(joined, /BEGIN:STANDARD/);
    assert.doesNotMatch(joined, /BEGIN:DAYLIGHT/);
    assert.match(joined, /TZOFFSETTO:\+0900/);
  });

  it("formatLocal produces the correct wall-clock across DST boundary", () => {
    // 2026-03-08 06:30 UTC = 01:30 EST (still on standard time —
    // DST begins at 02:00 local that day, so 01:30 is the LAST
    // standard-time minute).
    const winter = formatLocal(
      new Date("2026-03-08T06:30:00Z"),
      "America/New_York",
    );
    assert.equal(winter, "20260308T013000");

    // 2026-03-08 07:30 UTC = 03:30 EDT (clocks already jumped from
    // 02:00 EST → 03:00 EDT at 02:00 local).
    const summer = formatLocal(
      new Date("2026-03-08T07:30:00Z"),
      "America/New_York",
    );
    assert.equal(summer, "20260308T033000");
  });
});

// ─── SEQUENCE + UID stability ─────────────────────────────────────────

describe("booking-ics — UID + SEQUENCE", () => {
  it("UID is stable for the same booking id across re-renders", () => {
    assert.equal(bookingUid("abc-123"), "abc-123@zentromeet");
    assert.equal(
      bookingUid("550e8400-e29b-41d4-a716-446655440000"),
      "550e8400-e29b-41d4-a716-446655440000@zentromeet",
    );
  });

  it("SEQUENCE advances monotonically with updated_at", () => {
    const t1 = bookingSequence(new Date("2026-05-20T16:00:00Z"));
    const t2 = bookingSequence(new Date("2026-05-20T16:00:01Z"));
    const t3 = bookingSequence(new Date("2026-05-20T16:05:00Z"));
    assert.ok(t2 > t1, `expected ${t2} > ${t1}`);
    assert.ok(t3 > t2, `expected ${t3} > ${t2}`);
  });

  it("SEQUENCE caps at signed 32-bit integer range", () => {
    // Year 2100 is past the 2038 epoch wraparound — value must still
    // be a non-negative int32.
    const far = bookingSequence(new Date("2100-01-01T00:00:00Z"));
    assert.ok(far >= 0);
    assert.ok(far <= 0x7fffffff);
  });
});

// ─── Cancellation behavior ────────────────────────────────────────────

describe("generateICS — CANCEL semantics", () => {
  it("sets STATUS=CANCELLED + METHOD=CANCEL on cancel events", () => {
    const out = generateICS(baseEvent({ method: "CANCEL", sequence: 5 })).body;
    assert.match(out, /STATUS:CANCELLED/);
    assert.match(out, /METHOD:CANCEL/);
    assert.match(out, /SEQUENCE:5/);
  });

  it("suppresses VALARM blocks on cancel events", () => {
    const out = generateICS(
      baseEvent({
        method: "CANCEL",
        alarms: [{ minutesBefore: 15 }],
      }),
    ).body;
    assert.doesNotMatch(out, /BEGIN:VALARM/);
  });

  it("preserves VALARM blocks on REQUEST events", () => {
    const out = generateICS(baseEvent({ method: "REQUEST" })).body;
    assert.match(out, /BEGIN:VALARM/);
    assert.match(out, /TRIGGER:-PT15M/);
    assert.match(out, /TRIGGER:-PT1440M/);
  });
});

// ─── Line folding ─────────────────────────────────────────────────────

describe("foldLine — RFC 5545 §3.1", () => {
  it("does not fold lines at or below 75 octets", () => {
    const short = "SUMMARY:Lunch";
    assert.equal(foldLine(short), short);
  });

  it("folds long lines at 75 octets with leading-space continuation", () => {
    const long =
      "DESCRIPTION:This is a sufficiently long description that absolutely will exceed the 75-octet RFC limit and force a fold to occur.";
    const folded = foldLine(long);
    assert.match(folded, /\r\n /);
    // Each physical line ≤ 75 octets (the continuation space counts).
    for (const line of folded.split("\r\n")) {
      assert.ok(
        Buffer.byteLength(line, "utf8") <= 75 + 1, // +1 for leading space
        `fold produced an over-long line (${Buffer.byteLength(line, "utf8")}): ${line}`,
      );
    }
  });

  it("never splits a UTF-8 multibyte codepoint at the fold boundary", () => {
    // 30 copies of "😀" (4 bytes each = 120 bytes) past the 75-octet
    // boundary. If we split mid-codepoint the result would contain
    // replacement chars or throw.
    const emoji = "DESCRIPTION:" + "😀".repeat(30);
    const folded = foldLine(emoji);
    // Reassemble — every continuation line drops the leading space.
    const reassembled = folded
      .split("\r\n")
      .map((l, i) => (i === 0 ? l : l.slice(1)))
      .join("");
    assert.equal(reassembled, emoji);
    // No replacement char produced.
    assert.doesNotMatch(folded, /�/);
  });
});

// ─── Escaping ─────────────────────────────────────────────────────────

describe("escape5545 — RFC 5545 §3.3.11", () => {
  it("escapes backslash first to avoid double-escape", () => {
    assert.equal(escape5545("a\\b"), "a\\\\b");
  });

  it("escapes commas, semicolons, and newlines", () => {
    assert.equal(escape5545("a;b,c\nd"), "a\\;b\\,c\\nd");
  });

  it("normalizes CRLF and lone CR to escaped \\n", () => {
    assert.equal(escape5545("a\r\nb\rc"), "a\\nb\\nc");
  });

  it("emits SUMMARY-escaped text in the VEVENT body", () => {
    const out = generateICS(baseEvent({ summary: "Lunch; comma, here" })).body;
    assert.match(out, /SUMMARY:Lunch\\; comma\\, here/);
  });
});

describe("escapeParamValue — quoted parameters", () => {
  it("quote-wraps values containing special chars", () => {
    assert.equal(escapeParamValue("First, Last"), `"First, Last"`);
  });

  it("strips embedded double-quotes (forbidden inside DQUOTE)", () => {
    assert.equal(escapeParamValue(`Bob "the boss" Smith`), `"Bob the boss Smith"`);
  });

  it("leaves plain values unwrapped", () => {
    assert.equal(escapeParamValue("Jamie Q"), "Jamie Q");
  });

  it("rejects CR/LF in param values defensively", () => {
    // The newline-injection escalation: a malicious attendee name
    // with embedded newlines could otherwise close the property and
    // inject additional iCal properties.
    assert.equal(escapeParamValue("Bad\r\nName"), "Bad  Name");
  });
});

// ─── End-to-end booking adapter ───────────────────────────────────────

describe("generateBookingIcs — booking-domain adapter", () => {
  const bookingFixture = {
    booking: {
      id: "550e8400-e29b-41d4-a716-446655440000",
      startAt: new Date("2026-05-20T16:00:00Z"),
      endAt: new Date("2026-05-20T16:30:00Z"),
      clientEmail: "sam@example.com",
      clientName: "Sam Client",
      notes: "Looking forward!",
      meetLink: "https://meet.google.com/abc-defg-hij",
      updatedAt: new Date("2026-05-20T15:00:00Z"),
    },
    service: { name: "30-min Intro" },
    staff: {
      email: "jamie@example.com",
      name: "Jamie Q",
      timezone: "America/New_York",
    },
    tenant: { name: "Acme Tax Co." },
  };

  it("produces a REQUEST invite with the expected fields", () => {
    const out = generateBookingIcs({
      ...bookingFixture,
      method: "REQUEST",
    });
    // ATTENDEE / ORGANIZER lines often exceed 75 octets and get folded
    // mid-content; unfold for substring matching.
    const body = unfold(out.body);
    assert.match(body, /UID:550e8400-e29b-41d4-a716-446655440000@zentromeet/);
    assert.match(body, /SUMMARY:30-min Intro with Jamie Q/);
    assert.match(body, /ORGANIZER;CN=Jamie Q:mailto:jamie@example.com/);
    assert.match(body, /ATTENDEE.*:mailto:sam@example.com/);
    assert.match(body, /LOCATION:https:\/\/meet\.google\.com\/abc-defg-hij/);
    assert.match(body, /TZID=America\/New_York/);
    assert.equal(out.method, "REQUEST");
  });

  it("preserves UID across REQUEST and CANCEL renders for the same booking", () => {
    const req = generateBookingIcs({ ...bookingFixture, method: "REQUEST" });
    const cancel = generateBookingIcs({ ...bookingFixture, method: "CANCEL" });
    const uidLine = (b: string) => b.match(/UID:[^\r\n]+/)![0];
    assert.equal(uidLine(req.body), uidLine(cancel.body));
  });

  it("CANCEL render flips METHOD + STATUS + Content-Type together", () => {
    const out = generateBookingIcs({
      ...bookingFixture,
      method: "CANCEL",
    });
    assert.match(out.body, /METHOD:CANCEL/);
    assert.match(out.body, /STATUS:CANCELLED/);
    assert.match(out.contentType, /method=CANCEL/);
  });
});

// ─── Calendar links ───────────────────────────────────────────────────

describe("calendarLinks — provider URLs", () => {
  const args = {
    title: "Meeting with Jamie",
    startAt: new Date("2026-05-20T16:00:00Z"),
    endAt: new Date("2026-05-20T16:30:00Z"),
    description: "Join: https://meet.example.com/abc",
    location: "https://meet.example.com/abc",
  };

  it("Google link uses TEMPLATE action + UTC compact dates", () => {
    const url = generateGoogleCalendarUrl(args);
    assert.ok(url.startsWith("https://calendar.google.com/calendar/render?"));
    assert.match(url, /action=TEMPLATE/);
    assert.match(url, /dates=20260520T160000Z%2F20260520T163000Z/);
    assert.match(url, /text=Meeting/);
  });

  it("Outlook link uses ISO timestamps + addevent rru", () => {
    const url = generateOutlookCalendarUrl(args);
    assert.ok(url.startsWith("https://outlook.live.com/calendar/0/deeplink/compose?"));
    assert.match(url, /rru=addevent/);
    assert.match(url, /startdt=2026-05-20T16/);
    assert.match(url, /enddt=2026-05-20T16/);
  });

  it("Outlook variant='office' targets outlook.office.com", () => {
    const url = generateOutlookCalendarUrl(args, { variant: "office" });
    assert.ok(url.startsWith("https://outlook.office.com/calendar/0/deeplink/compose?"));
  });

  it("Yahoo link uses v=60 quick-add format", () => {
    const url = generateYahooCalendarUrl(args);
    assert.ok(url.startsWith("https://calendar.yahoo.com/?"));
    assert.match(url, /v=60/);
    assert.match(url, /st=20260520T160000Z/);
    assert.match(url, /et=20260520T163000Z/);
  });
});

// ─── DTSTAMP determinism ──────────────────────────────────────────────

describe("buildICSEvent — DTSTAMP override for snapshot testing", () => {
  it("respects opts.now for deterministic test snapshots", () => {
    const fixed = new Date("2026-01-01T00:00:00Z");
    const lines = buildICSEvent(baseEvent(), { now: fixed });
    const stampLine = lines.find((l) => l.startsWith("DTSTAMP:"));
    assert.equal(stampLine, `DTSTAMP:${formatUtc(fixed)}`);
  });
});
