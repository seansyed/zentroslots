/**
 * Unit tests for the pure parts of lib/waitlists.
 *
 * - matching.ts:  hourToRange + rankCandidate + pickBest
 * - types.ts:     closed unions
 *
 * Token + orchestrators + claim flow touch DB/HTTP and are exercised
 * in the production smoke phase.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hourToRange,
  pickBest,
  rankCandidate,
  type RankedCandidate,
} from "../lib/waitlists/matching";
import {
  WAITLIST_TIME_RANGES,
  DEFAULT_RESERVATION_MINUTES,
} from "../lib/waitlists/types";
import { TEMPLATE_TYPES } from "../lib/communications/template-types";

describe("waitlists: hourToRange", () => {
  it("morning is 5..11", () => {
    assert.equal(hourToRange(5), "morning");
    assert.equal(hourToRange(8), "morning");
    assert.equal(hourToRange(11), "morning");
  });
  it("afternoon is 12..16", () => {
    assert.equal(hourToRange(12), "afternoon");
    assert.equal(hourToRange(15), "afternoon");
    assert.equal(hourToRange(16), "afternoon");
  });
  it("evening is 17..22", () => {
    assert.equal(hourToRange(17), "evening");
    assert.equal(hourToRange(20), "evening");
    assert.equal(hourToRange(22), "evening");
  });
  it("late night / pre-dawn returns 'any'", () => {
    assert.equal(hourToRange(0), "any");
    assert.equal(hourToRange(23), "any");
    assert.equal(hourToRange(4), "any");
  });
});

describe("waitlists: rankCandidate", () => {
  const slot = { date: "2026-06-15", hour: 14 }; // afternoon

  it("rank 0: exact date + specific matching range", () => {
    const r = rankCandidate(
      { preferredDate: "2026-06-15", preferredTimeRange: "afternoon" },
      slot
    );
    assert.equal(r, 0);
  });
  it("rank 1: exact date, any time", () => {
    const r = rankCandidate(
      { preferredDate: "2026-06-15", preferredTimeRange: "any" },
      slot
    );
    assert.equal(r, 1);
  });
  it("rank 2: time range matches, no preferred date", () => {
    const r = rankCandidate(
      { preferredDate: null, preferredTimeRange: "afternoon" },
      slot
    );
    assert.equal(r, 2);
  });
  it("rank 3: any-date, any-range (service-level fallback)", () => {
    const r = rankCandidate(
      { preferredDate: null, preferredTimeRange: "any" },
      slot
    );
    assert.equal(r, 3);
  });

  it("99: preferred date set and doesn't match", () => {
    const r = rankCandidate(
      { preferredDate: "2026-07-01", preferredTimeRange: "afternoon" },
      slot
    );
    assert.equal(r, 99);
  });
  it("99: time range set, doesn't match, no date", () => {
    const r = rankCandidate(
      { preferredDate: null, preferredTimeRange: "morning" },
      slot
    );
    assert.equal(r, 99);
  });

  it("rank 0 wins over rank 1 even with later createdAt (verified via pickBest)", () => {
    // Sanity: exact date + range beats exact date + any.
    const a: RankedCandidate = {
      preferredDate: "2026-06-15",
      preferredTimeRange: "afternoon",
      rank: 0,
      priority: 0,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    };
    const b: RankedCandidate = {
      preferredDate: "2026-06-15",
      preferredTimeRange: "any",
      rank: 1,
      priority: 0,
      createdAt: new Date("2026-05-01T00:00:00Z"), // earlier — would win FIFO
    };
    assert.equal(pickBest([a, b]), a);
  });
});

describe("waitlists: pickBest", () => {
  const baseDate = new Date("2026-06-01T00:00:00Z");

  it("returns null on empty pool", () => {
    assert.equal(pickBest([]), null);
  });

  it("FIFO within same rank + priority", () => {
    const older: RankedCandidate = {
      preferredDate: null,
      preferredTimeRange: "any",
      rank: 3,
      priority: 0,
      createdAt: new Date(baseDate.getTime() - 60_000),
    };
    const newer: RankedCandidate = {
      preferredDate: null,
      preferredTimeRange: "any",
      rank: 3,
      priority: 0,
      createdAt: baseDate,
    };
    assert.equal(pickBest([newer, older]), older);
  });

  it("higher priority wins despite later createdAt within same rank", () => {
    const lowPrioOld: RankedCandidate = {
      preferredDate: null,
      preferredTimeRange: "any",
      rank: 3,
      priority: 0,
      createdAt: new Date(baseDate.getTime() - 60_000),
    };
    const highPrioNew: RankedCandidate = {
      preferredDate: null,
      preferredTimeRange: "any",
      rank: 3,
      priority: 10,
      createdAt: baseDate,
    };
    assert.equal(pickBest([lowPrioOld, highPrioNew]), highPrioNew);
  });

  it("never picks ineligible (rank 99)", () => {
    const ineligible: RankedCandidate = {
      preferredDate: "2026-07-01",
      preferredTimeRange: "afternoon",
      rank: 99,
      priority: 100,
      createdAt: baseDate,
    };
    assert.equal(pickBest([ineligible]), null);
  });

  it("rank 1 beats rank 2 even with same priority", () => {
    const date_match: RankedCandidate = {
      preferredDate: "2026-06-15",
      preferredTimeRange: "any",
      rank: 1,
      priority: 0,
      createdAt: baseDate,
    };
    const range_match: RankedCandidate = {
      preferredDate: null,
      preferredTimeRange: "afternoon",
      rank: 2,
      priority: 0,
      createdAt: new Date(baseDate.getTime() - 60_000), // earlier — but rank loses
    };
    assert.equal(pickBest([date_match, range_match]), date_match);
  });
});

describe("waitlists: closed unions + constants", () => {
  it("WAITLIST_TIME_RANGES covers expected values", () => {
    assert.ok(WAITLIST_TIME_RANGES.includes("morning"));
    assert.ok(WAITLIST_TIME_RANGES.includes("afternoon"));
    assert.ok(WAITLIST_TIME_RANGES.includes("evening"));
    assert.ok(WAITLIST_TIME_RANGES.includes("any"));
  });
  it("DEFAULT_RESERVATION_MINUTES is 15 per spec", () => {
    assert.equal(DEFAULT_RESERVATION_MINUTES, 15);
  });
  it("TEMPLATE_TYPES gained waitlist_slot_available", () => {
    assert.ok(TEMPLATE_TYPES.includes("waitlist_slot_available"));
  });
});
