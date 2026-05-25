/**
 * Phase ICAL-3 — external ICS feed import tests.
 *
 * Coverage:
 *   • parseICSFeed — single events, recurring (RRULE), cancellation
 *     filter, transparent filter, malformed feed tolerance,
 *     window culling, event-count cap
 *   • classifyFeedUrl — Apple iCloud / Outlook / Google detection
 *   • normalizedFeedHash — deterministic SHA-256
 *   • safeFetch — SSRF defenses (private IP blocking, scheme allowlist,
 *     localhost blocking). We can't run a full network test in unit
 *     scope but we CAN verify the gate rejects the URLs we care about.
 *
 * Tests that need a real DB or HTTP target (the per-feed orchestrator's
 * round trip, the availability bridge's actual rows) live elsewhere —
 * the production smoke step at the end.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFeedUrl,
  parseICSFeed,
} from "../lib/calendar/externalFeeds/parseICSFeed";
import { normalizedFeedHash } from "../lib/calendar/externalFeeds/syncExternalFeed";
import { safeFetch } from "../lib/security/safeFetch";

// ─── Test fixtures ────────────────────────────────────────────────────

/** A minimal RFC 5545 VCALENDAR fixture. Note: we use \r\n line
 *  endings as the parser expects per spec. */
function buildICS(events: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    "CALSCALE:GREGORIAN",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

const SAMPLE_EVENT = [
  "BEGIN:VEVENT",
  "UID:event-1@example",
  "SUMMARY:Lunch with Jamie",
  "DTSTART:20260601T120000Z",
  "DTEND:20260601T130000Z",
  "STATUS:CONFIRMED",
  "END:VEVENT",
].join("\r\n");

const SAMPLE_CANCELLED = [
  "BEGIN:VEVENT",
  "UID:event-cancelled@example",
  "SUMMARY:Cancelled meeting",
  "DTSTART:20260602T120000Z",
  "DTEND:20260602T130000Z",
  "STATUS:CANCELLED",
  "END:VEVENT",
].join("\r\n");

const SAMPLE_TRANSPARENT = [
  "BEGIN:VEVENT",
  "UID:event-free@example",
  "SUMMARY:Birthday reminder",
  "DTSTART:20260603T120000Z",
  "DTEND:20260603T130000Z",
  "TRANSP:TRANSPARENT",
  "END:VEVENT",
].join("\r\n");

// ─── parseICSFeed ─────────────────────────────────────────────────────

describe("parseICSFeed — single event", () => {
  it("extracts a single VEVENT with start/end + summary", () => {
    const body = buildICS([SAMPLE_EVENT]);
    const { events } = parseICSFeed(body, { now: new Date("2026-06-01T00:00:00Z") });
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, "Lunch with Jamie");
    assert.equal(events[0].status, "CONFIRMED");
    assert.equal(events[0].startAt.toISOString(), "2026-06-01T12:00:00.000Z");
    assert.equal(events[0].endAt.toISOString(), "2026-06-01T13:00:00.000Z");
  });

  it("drops STATUS:CANCELLED events", () => {
    const body = buildICS([SAMPLE_EVENT, SAMPLE_CANCELLED]);
    const { events } = parseICSFeed(body, { now: new Date("2026-06-01T00:00:00Z") });
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, "Lunch with Jamie");
  });

  it("drops TRANSP:TRANSPARENT events (user marked free time)", () => {
    const body = buildICS([SAMPLE_EVENT, SAMPLE_TRANSPARENT]);
    const { events } = parseICSFeed(body, { now: new Date("2026-06-01T00:00:00Z") });
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, "Lunch with Jamie");
  });

  it("culls events outside the [now-30d, now+180d] window", () => {
    // Event in the past (>30d ago)
    const past = [
      "BEGIN:VEVENT",
      "UID:past@example",
      "DTSTART:20200101T120000Z",
      "DTEND:20200101T130000Z",
      "SUMMARY:Way old",
      "END:VEVENT",
    ].join("\r\n");
    // Event far future (>180d)
    const farFuture = [
      "BEGIN:VEVENT",
      "UID:future@example",
      "DTSTART:20990101T120000Z",
      "DTEND:20990101T130000Z",
      "SUMMARY:Way future",
      "END:VEVENT",
    ].join("\r\n");
    const body = buildICS([past, farFuture, SAMPLE_EVENT]);
    const { events } = parseICSFeed(body, { now: new Date("2026-06-01T00:00:00Z") });
    assert.equal(events.length, 1);
    assert.equal(events[0].summary, "Lunch with Jamie");
  });

  it("skips events with missing or inverted start/end", () => {
    const broken = [
      "BEGIN:VEVENT",
      "UID:broken@example",
      "DTSTART:20260601T130000Z",
      "DTEND:20260601T120000Z", // end before start
      "SUMMARY:Backwards",
      "END:VEVENT",
    ].join("\r\n");
    const body = buildICS([SAMPLE_EVENT, broken]);
    const { events, warnings } = parseICSFeed(body, {
      now: new Date("2026-06-01T00:00:00Z"),
    });
    assert.equal(events.length, 1);
    assert.ok(warnings.some((w) => w.includes("broken@example")));
  });

  it("returns empty + warning on completely malformed input", () => {
    const { events, warnings } = parseICSFeed("not actually ical at all");
    // node-ical is tolerant of garbage — returns 0 events without throwing.
    assert.equal(events.length, 0);
    // We accept either a parser warning or no warning; the key is
    // that we DIDN'T throw.
    assert.ok(Array.isArray(warnings));
  });

  it("sorts events by startAt ascending", () => {
    const e1 = [
      "BEGIN:VEVENT",
      "UID:later@example",
      "DTSTART:20260601T150000Z",
      "DTEND:20260601T160000Z",
      "SUMMARY:Later",
      "END:VEVENT",
    ].join("\r\n");
    const body = buildICS([e1, SAMPLE_EVENT]); // backwards in input
    const { events } = parseICSFeed(body, { now: new Date("2026-06-01T00:00:00Z") });
    assert.equal(events.length, 2);
    assert.equal(events[0].summary, "Lunch with Jamie"); // earlier
    assert.equal(events[1].summary, "Later");
  });

  it("respects maxEvents cap", () => {
    // Build 5 events; cap at 3.
    const evs: string[] = [];
    for (let i = 0; i < 5; i++) {
      evs.push(
        [
          "BEGIN:VEVENT",
          `UID:event-${i}@example`,
          `DTSTART:202606${String(10 + i).padStart(2, "0")}T120000Z`,
          `DTEND:202606${String(10 + i).padStart(2, "0")}T130000Z`,
          `SUMMARY:Event ${i}`,
          "END:VEVENT",
        ].join("\r\n"),
      );
    }
    const body = buildICS(evs);
    const { events, recurrenceClamped } = parseICSFeed(body, {
      now: new Date("2026-06-01T00:00:00Z"),
      maxEvents: 3,
    });
    assert.equal(events.length, 3);
    assert.equal(recurrenceClamped, true);
  });
});

describe("parseICSFeed — recurring events", () => {
  it("expands a daily RRULE for occurrences inside the window", () => {
    const recurring = [
      "BEGIN:VEVENT",
      "UID:daily-standup@example",
      "DTSTART:20260601T140000Z",
      "DTEND:20260601T143000Z",
      "RRULE:FREQ=DAILY;COUNT=5",
      "SUMMARY:Daily standup",
      "END:VEVENT",
    ].join("\r\n");
    const body = buildICS([recurring]);
    const { events } = parseICSFeed(body, {
      now: new Date("2026-06-01T00:00:00Z"),
    });
    // 5 occurrences expected.
    assert.equal(events.length, 5);
    // All same duration (30 min).
    for (const e of events) {
      const durMs = e.endAt.getTime() - e.startAt.getTime();
      assert.equal(durMs, 30 * 60_000);
    }
    // Sorted ascending.
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].startAt > events[i - 1].startAt);
    }
  });
});

// ─── classifyFeedUrl ──────────────────────────────────────────────────

describe("classifyFeedUrl", () => {
  it("detects Apple iCloud", () => {
    const { kind } = classifyFeedUrl(
      "https://p49-caldav.icloud.com/published/2/AB123CD-456",
    );
    assert.equal(kind, "apple_icloud");
  });

  it("detects Outlook", () => {
    const { kind } = classifyFeedUrl(
      "https://outlook.office365.com/owa/calendar/abc/calendar.ics",
    );
    assert.equal(kind, "outlook");
  });

  it("detects Google", () => {
    const { kind } = classifyFeedUrl(
      "https://calendar.google.com/calendar/ical/foo%40group.calendar.google.com/public/basic.ics",
    );
    assert.equal(kind, "google");
  });

  it("falls back to 'other' for an unknown host", () => {
    const { kind } = classifyFeedUrl("https://example.com/cal.ics");
    assert.equal(kind, "other");
  });

  it("normalizes lowercase host + drops fragment", () => {
    const { normalized } = classifyFeedUrl(
      "https://ICloud.COM/published/foo#fragment",
    );
    assert.ok(!normalized.includes("#"));
    assert.ok(/icloud\.com/.test(normalized));
  });
});

// ─── normalizedFeedHash ───────────────────────────────────────────────

describe("normalizedFeedHash", () => {
  it("is deterministic + 64 hex chars", () => {
    const h = normalizedFeedHash("https://example.com/cal.ics");
    assert.equal(h.length, 64);
    assert.equal(h, normalizedFeedHash("https://example.com/cal.ics"));
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("distinguishes different URLs", () => {
    assert.notEqual(
      normalizedFeedHash("https://example.com/a.ics"),
      normalizedFeedHash("https://example.com/b.ics"),
    );
  });
});

// ─── safeFetch — SSRF defenses ────────────────────────────────────────

describe("safeFetch — SSRF defenses", () => {
  it("rejects file:// scheme", async () => {
    const r = await safeFetch("file:///etc/passwd");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "scheme");
  });

  it("rejects ftp://", async () => {
    const r = await safeFetch("ftp://example.com/cal.ics");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "scheme");
  });

  it("rejects URLs with embedded userinfo", async () => {
    const r = await safeFetch("https://user:pass@example.com/cal.ics");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "scheme");
  });

  it("rejects http://localhost", async () => {
    // localhost should be caught either by scheme (when ALLOW_HTTP_FEEDS
    // is not set) or by the hostname check. Either way → not ok.
    const r = await safeFetch("http://localhost:6379/");
    assert.equal(r.ok, false);
  });

  it("rejects http://127.0.0.1 via SSRF gate", async () => {
    // Even if scheme allowed, the resolved IP is loopback.
    const original = process.env.ALLOW_HTTP_FEEDS;
    process.env.ALLOW_HTTP_FEEDS = "1";
    try {
      const r = await safeFetch("http://127.0.0.1/");
      assert.equal(r.ok, false);
      if (!r.ok) {
        // Either ssrf_blocked (host literal IP) or fails earlier.
        assert.ok(
          r.reason === "ssrf_blocked" || r.reason === "dns_failed",
          `expected ssrf_blocked, got ${r.reason}`,
        );
      }
    } finally {
      if (original === undefined) delete process.env.ALLOW_HTTP_FEEDS;
      else process.env.ALLOW_HTTP_FEEDS = original;
    }
  });

  it("rejects http://10.0.0.1 (private network)", async () => {
    const original = process.env.ALLOW_HTTP_FEEDS;
    process.env.ALLOW_HTTP_FEEDS = "1";
    try {
      const r = await safeFetch("http://10.0.0.1/cal");
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(r.reason === "ssrf_blocked" || r.reason === "dns_failed");
      }
    } finally {
      if (original === undefined) delete process.env.ALLOW_HTTP_FEEDS;
      else process.env.ALLOW_HTTP_FEEDS = original;
    }
  });

  it("rejects AWS metadata IP 169.254.169.254", async () => {
    const original = process.env.ALLOW_HTTP_FEEDS;
    process.env.ALLOW_HTTP_FEEDS = "1";
    try {
      const r = await safeFetch("http://169.254.169.254/latest/meta-data/");
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.ok(r.reason === "ssrf_blocked" || r.reason === "dns_failed");
      }
    } finally {
      if (original === undefined) delete process.env.ALLOW_HTTP_FEEDS;
      else process.env.ALLOW_HTTP_FEEDS = original;
    }
  });

  it("rejects malformed URL", async () => {
    const r = await safeFetch("not a url at all");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "scheme");
  });
});
