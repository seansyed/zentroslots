/**
 * Unit tests for the pure parts of lib/recurrence.
 *
 * - recurrenceRules.ts: parse + serialize
 * - expandSeries.ts:    enumerate occurrences for each FREQ + BYDAY
 *                       + UNTIL/COUNT variant
 * - validateRecurrence.ts: rule sanity guards
 * - exceptions.ts:      sanitizeOverride
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseRecurrenceRule,
  RecurrenceParseError,
  serializeRecurrenceRule,
} from "../lib/recurrence/recurrenceRules";
import { expandSeries } from "../lib/recurrence/expandSeries";
import { validateRecurrenceRuleString } from "../lib/recurrence/validateRecurrence";
import { applyOverride, sanitizeOverride } from "../lib/recurrence/exceptions";

describe("recurrence: parse / serialize", () => {
  it("parses FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10", () => {
    const r = parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;COUNT=10");
    assert.equal(r.freq, "WEEKLY");
    assert.equal(r.interval, 2);
    assert.deepEqual(r.byday, ["MO", "WE", "FR"]);
    assert.equal(r.count, 10);
    assert.equal(r.until, undefined);
  });
  it("tolerates RRULE: prefix + whitespace", () => {
    const r = parseRecurrenceRule("RRULE:FREQ=DAILY ;  INTERVAL=3 ");
    assert.equal(r.freq, "DAILY");
    assert.equal(r.interval, 3);
  });
  it("defaults INTERVAL to 1", () => {
    const r = parseRecurrenceRule("FREQ=DAILY");
    assert.equal(r.interval, 1);
  });
  it("rejects UNTIL + COUNT together", () => {
    assert.throws(
      () => parseRecurrenceRule("FREQ=DAILY;UNTIL=20261225;COUNT=5"),
      RecurrenceParseError
    );
  });
  it("rejects unknown FREQ", () => {
    assert.throws(() => parseRecurrenceRule("FREQ=YEARLY"), RecurrenceParseError);
  });
  it("rejects invalid INTERVAL", () => {
    assert.throws(() => parseRecurrenceRule("FREQ=DAILY;INTERVAL=0"), RecurrenceParseError);
    assert.throws(() => parseRecurrenceRule("FREQ=DAILY;INTERVAL=-1"), RecurrenceParseError);
  });
  it("rejects garbage BYDAY", () => {
    assert.throws(
      () => parseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO,XX"),
      RecurrenceParseError
    );
  });
  it("serializes round-trip-stable", () => {
    const input = "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10";
    const parsed = parseRecurrenceRule(input);
    assert.equal(serializeRecurrenceRule(parsed), input);
  });
});

describe("recurrence: validate", () => {
  it("accepts a normal rule", () => {
    const v = validateRecurrenceRuleString("FREQ=WEEKLY;BYDAY=MO;COUNT=10");
    assert.equal(v.ok, true);
  });
  it("rejects BYDAY with non-WEEKLY freq", () => {
    const v = validateRecurrenceRuleString("FREQ=DAILY;BYDAY=MO");
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /BYDAY/);
  });
  it("rejects huge INTERVAL", () => {
    const v = validateRecurrenceRuleString("FREQ=DAILY;INTERVAL=99999");
    assert.equal(v.ok, false);
  });
  it("rejects huge COUNT", () => {
    const v = validateRecurrenceRuleString("FREQ=DAILY;COUNT=99999");
    assert.equal(v.ok, false);
  });
});

describe("recurrence: expandSeries DAILY", () => {
  it("emits N daily occurrences with INTERVAL=1", () => {
    const rule = parseRecurrenceRule("FREQ=DAILY;COUNT=5");
    const occs = expandSeries({
      rule,
      startLocal: "2026-06-01T09:00:00",
      timezone: "UTC",
      windowEnd: new Date("2026-12-31T00:00:00Z"),
    });
    assert.equal(occs.length, 5);
    assert.equal(occs[0].startAt.toISOString(), "2026-06-01T09:00:00.000Z");
    assert.equal(occs[1].startAt.toISOString(), "2026-06-02T09:00:00.000Z");
    assert.equal(occs[4].startAt.toISOString(), "2026-06-05T09:00:00.000Z");
  });
  it("respects INTERVAL=3", () => {
    const rule = parseRecurrenceRule("FREQ=DAILY;INTERVAL=3;COUNT=3");
    const occs = expandSeries({
      rule,
      startLocal: "2026-06-01T09:00:00",
      timezone: "UTC",
      windowEnd: new Date("2026-12-31T00:00:00Z"),
    });
    assert.deepEqual(
      occs.map((o) => o.startAt.toISOString()),
      ["2026-06-01T09:00:00.000Z", "2026-06-04T09:00:00.000Z", "2026-06-07T09:00:00.000Z"]
    );
  });
});

describe("recurrence: expandSeries WEEKLY", () => {
  it("emits N weekly occurrences without BYDAY (anchor weekday only)", () => {
    // 2026-06-01 is a Monday
    const rule = parseRecurrenceRule("FREQ=WEEKLY;COUNT=4");
    const occs = expandSeries({
      rule,
      startLocal: "2026-06-01T10:00:00",
      timezone: "UTC",
      windowEnd: new Date("2026-12-31T00:00:00Z"),
    });
    assert.equal(occs.length, 4);
    assert.deepEqual(
      occs.map((o) => o.startAt.toISOString().slice(0, 10)),
      ["2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22"]
    );
  });

  it("BYDAY=MO,WE,FR emits 3 days/week in order", () => {
    // 2026-06-01 is a Monday. Week 1: Mon Jun 1, Wed Jun 3, Fri Jun 5.
    // Week 2: Mon Jun 8, Wed Jun 10, Fri Jun 12.
    const rule = parseRecurrenceRule("FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6");
    const occs = expandSeries({
      rule,
      startLocal: "2026-06-01T08:00:00",
      timezone: "UTC",
      windowEnd: new Date("2026-12-31T00:00:00Z"),
    });
    assert.deepEqual(
      occs.map((o) => o.startAt.toISOString().slice(0, 10)),
      ["2026-06-01", "2026-06-03", "2026-06-05", "2026-06-08", "2026-06-10", "2026-06-12"]
    );
  });

  it("INTERVAL=2 doubles the week gap", () => {
    const rule = parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;COUNT=3");
    const occs = expandSeries({
      rule,
      startLocal: "2026-06-01T10:00:00",
      timezone: "UTC",
      windowEnd: new Date("2026-12-31T00:00:00Z"),
    });
    assert.deepEqual(
      occs.map((o) => o.startAt.toISOString().slice(0, 10)),
      ["2026-06-01", "2026-06-15", "2026-06-29"]
    );
  });

  it("UNTIL caps the series", () => {
    const rule = parseRecurrenceRule("FREQ=WEEKLY;UNTIL=20260622");
    const occs = expandSeries({
      rule,
      startLocal: "2026-06-01T10:00:00",
      timezone: "UTC",
      windowEnd: new Date("2026-12-31T00:00:00Z"),
    });
    // Jun 1, 8, 15, 22 → 4 (UNTIL inclusive end-of-day)
    assert.equal(occs.length, 4);
  });
});

describe("recurrence: expandSeries MONTHLY", () => {
  it("emits N monthly occurrences on the same day", () => {
    const rule = parseRecurrenceRule("FREQ=MONTHLY;COUNT=4");
    const occs = expandSeries({
      rule,
      startLocal: "2026-01-15T10:00:00",
      timezone: "UTC",
      windowEnd: new Date("2027-06-01T00:00:00Z"),
    });
    assert.deepEqual(
      occs.map((o) => o.startAt.toISOString().slice(0, 10)),
      ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]
    );
  });

  it("clamps day for short months (Jan 31 → Feb 28)", () => {
    const rule = parseRecurrenceRule("FREQ=MONTHLY;COUNT=3");
    const occs = expandSeries({
      rule,
      startLocal: "2026-01-31T10:00:00",
      timezone: "UTC",
      windowEnd: new Date("2027-06-01T00:00:00Z"),
    });
    // Jan 31 → Feb 28 (2026 is not leap) → Mar 31
    assert.deepEqual(
      occs.map((o) => o.startAt.toISOString().slice(0, 10)),
      ["2026-01-31", "2026-02-28", "2026-03-31"]
    );
  });
});

describe("recurrence: expandSeries windowing", () => {
  it("respects windowEnd (early cap)", () => {
    const rule = parseRecurrenceRule("FREQ=DAILY;COUNT=100");
    const occs = expandSeries({
      rule,
      startLocal: "2026-06-01T09:00:00",
      timezone: "UTC",
      windowEnd: new Date("2026-06-04T00:00:00Z"),
    });
    // Window is 06-01 09:00 .. 06-04 00:00 → emits 06-01, 06-02, 06-03 → 3
    assert.equal(occs.length, 3);
  });

  it("startIndex resumes after high-water mark", () => {
    const rule = parseRecurrenceRule("FREQ=DAILY;COUNT=10");
    const all = expandSeries({
      rule,
      startLocal: "2026-06-01T09:00:00",
      timezone: "UTC",
      windowEnd: new Date("2027-01-01T00:00:00Z"),
    });
    const resumed = expandSeries({
      rule,
      startLocal: "2026-06-01T09:00:00",
      timezone: "UTC",
      windowEnd: new Date("2027-01-01T00:00:00Z"),
      startIndex: 5,
    });
    assert.equal(resumed.length, 5);
    assert.equal(resumed[0].index, 5);
    assert.equal(resumed[0].startAt.toISOString(), all[5].startAt.toISOString());
  });
});

describe("recurrence: applyOverride", () => {
  const baseStart = new Date("2026-06-01T17:00:00.000Z");

  it("returns series defaults with empty override", () => {
    const out = applyOverride({
      seriesStartAt: baseStart,
      seriesStaffUserId: "user-a",
      override: {},
    });
    assert.equal(out.startAt.toISOString(), baseStart.toISOString());
    assert.equal(out.staffUserId, "user-a");
    assert.equal(out.shouldSkip, false);
  });

  it("override.startAt wins", () => {
    const out = applyOverride({
      seriesStartAt: baseStart,
      seriesStaffUserId: "user-a",
      override: { startAt: "2026-06-02T19:00:00.000Z" },
    });
    assert.equal(out.startAt.toISOString(), "2026-06-02T19:00:00.000Z");
  });

  it("override.staffUserId wins", () => {
    const out = applyOverride({
      seriesStartAt: baseStart,
      seriesStaffUserId: "user-a",
      override: { staffUserId: "user-b" },
    });
    assert.equal(out.staffUserId, "user-b");
  });

  it("override.skip flags the occurrence", () => {
    const out = applyOverride({
      seriesStartAt: baseStart,
      seriesStaffUserId: "user-a",
      override: { skip: true },
    });
    assert.equal(out.shouldSkip, true);
  });
});

describe("recurrence: sanitizeOverride", () => {
  it("drops unknown keys", () => {
    const out = sanitizeOverride({
      startAt: "2026-06-01",
      staffUserId: "x",
      injected: "evil",
      skip: true,
    });
    const keys = Object.keys(out).sort();
    assert.deepEqual(keys, ["skip", "staffUserId", "startAt"]);
  });
  it("returns empty object on garbage input", () => {
    assert.deepEqual(sanitizeOverride(null), {});
    assert.deepEqual(sanitizeOverride("string"), {});
    assert.deepEqual(sanitizeOverride([]), {});
  });
  it("type-checks each field", () => {
    const out = sanitizeOverride({
      startAt: 123,
      staffUserId: { not: "a string" },
      skip: "true",
    });
    assert.deepEqual(out, {});
  });
});
