/**
 * Phase SMART-2 — scheduling workflow tests.
 *
 * Coverage:
 *   • Pure helpers in workflowRules.ts:
 *     - bucketTimeOfDay across morning/midday/afternoon/evening
 *     - isSameDayInTz timezone-aware
 *     - tagComparison earlier/same-day/different-day/first-available
 *     - generateReasoning template determinism (no LLM strings)
 *     - formatHeadlineTime stable format
 *     - buildHeadline returns null below score threshold
 *     - promoteRecommendations sort + cap + delta math
 *   • Determinism: same input twice → identical output (structural)
 *   • Safety: empty input → empty output; bad input doesn't throw
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bucketTimeOfDay,
  buildHeadline,
  formatHeadlineTime,
  generateReasoning,
  isSameDayInTz,
  promoteRecommendations,
  tagComparison,
} from "../lib/scheduling/workflows/workflowRules";
import type { ScoredSlot } from "../lib/scheduling/intelligence/types";
import type { WorkflowRecommendation } from "../lib/scheduling/workflows/types";

const TZ_NY = "America/New_York";
const D = (iso: string) => new Date(iso);

// ─── Bucketing ────────────────────────────────────────────────────────

describe("bucketTimeOfDay", () => {
  it("returns morning for 10am EDT", () => {
    // 14:00 UTC June = 10 EDT
    assert.equal(bucketTimeOfDay(D("2026-06-15T14:00:00Z"), TZ_NY), "morning");
  });
  it("returns midday for 12 EDT", () => {
    assert.equal(bucketTimeOfDay(D("2026-06-15T16:00:00Z"), TZ_NY), "midday");
  });
  it("returns afternoon for 15 EDT", () => {
    assert.equal(bucketTimeOfDay(D("2026-06-15T19:00:00Z"), TZ_NY), "afternoon");
  });
  it("returns evening for 19 EDT", () => {
    assert.equal(bucketTimeOfDay(D("2026-06-15T23:00:00Z"), TZ_NY), "evening");
  });
  it("returns early-morning for 6 EDT", () => {
    assert.equal(bucketTimeOfDay(D("2026-06-15T10:00:00Z"), TZ_NY), "early-morning");
  });
});

// ─── Same day check ──────────────────────────────────────────────────

describe("isSameDayInTz", () => {
  it("true for two times on the same EDT calendar day", () => {
    assert.equal(
      isSameDayInTz(D("2026-06-15T13:00:00Z"), D("2026-06-15T22:00:00Z"), TZ_NY),
      true,
    );
  });
  it("false across midnight EDT boundary", () => {
    // 2026-06-15T03:00:00Z = 23:00 EDT June 14
    // 2026-06-15T05:00:00Z = 01:00 EDT June 15
    assert.equal(
      isSameDayInTz(D("2026-06-15T03:00:00Z"), D("2026-06-15T05:00:00Z"), TZ_NY),
      false,
    );
  });
});

// ─── Comparison tagging ──────────────────────────────────────────────

describe("tagComparison", () => {
  const ref = D("2026-06-15T17:00:00Z"); // 13 EDT

  it("'earlier' when slot precedes reference", () => {
    assert.equal(
      tagComparison({
        slotStart: D("2026-06-15T14:00:00Z"), // 10 EDT, earlier
        referenceTime: ref,
        isFirstInList: false,
        score: 80,
        tz: TZ_NY,
      }),
      "earlier",
    );
  });

  it("'same_day' when later on the same day", () => {
    assert.equal(
      tagComparison({
        slotStart: D("2026-06-15T19:00:00Z"), // 15 EDT same day, later
        referenceTime: ref,
        isFirstInList: false,
        score: 80,
        tz: TZ_NY,
      }),
      "same_day",
    );
  });

  it("'different_day' when on another calendar day", () => {
    assert.equal(
      tagComparison({
        slotStart: D("2026-06-16T14:00:00Z"),
        referenceTime: ref,
        isFirstInList: false,
        score: 80,
        tz: TZ_NY,
      }),
      "different_day",
    );
  });

  it("'first_available' for first-in-list with no reference + high score", () => {
    assert.equal(
      tagComparison({
        slotStart: D("2026-06-15T14:00:00Z"),
        referenceTime: null,
        isFirstInList: true,
        score: 80,
        tz: TZ_NY,
      }),
      "first_available",
    );
  });

  it("'different_day' when low-scoring without reference", () => {
    assert.equal(
      tagComparison({
        slotStart: D("2026-06-15T14:00:00Z"),
        referenceTime: null,
        isFirstInList: true,
        score: 40, // below 60
        tz: TZ_NY,
      }),
      "different_day",
    );
  });
});

// ─── Reasoning template ──────────────────────────────────────────────

describe("generateReasoning", () => {
  it("always returns at least one line (fallback)", () => {
    const r = generateReasoning(undefined);
    assert.ok(r.length >= 1);
    assert.match(r[0], /no scheduling conflicts/i);
  });

  it("returns 'Peak booking hour' when timeOfDay >= 90", () => {
    const r = generateReasoning([
      { factor: "timeOfDay", score: 95 },
    ]);
    assert.ok(r.some((line) => line.includes("Peak booking hour")));
  });

  it("returns 'Matches your usual' when customerPreference >= 85", () => {
    const r = generateReasoning([
      { factor: "customerPreference", score: 95 },
    ]);
    assert.ok(r.some((line) => line.includes("usual booking time")));
  });

  it("caps at 3 lines", () => {
    const r = generateReasoning([
      { factor: "timeOfDay", score: 95 },
      { factor: "customerPreference", score: 90 },
      { factor: "workloadBalance", score: 100 },
      { factor: "dailyDensity", score: 100 },
      { factor: "focusBlockRespect", score: 100 },
      { factor: "bufferEfficiency", score: 100 },
    ]);
    assert.ok(r.length <= 3);
  });

  it("is deterministic across calls", () => {
    const input = [
      { factor: "timeOfDay" as const, score: 95 },
      { factor: "lunchAvoidance" as const, score: 60 },
    ];
    const a = generateReasoning(input);
    const b = generateReasoning(input);
    assert.deepEqual(a, b);
  });

  it("surfaces lunch-overlap as a hint when score < 80", () => {
    const r = generateReasoning([
      { factor: "lunchAvoidance", score: 60 },
    ]);
    assert.ok(r.some((line) => line.toLowerCase().includes("lunch")));
  });

  it("never contains LLM-generated artifacts (no quote chars, no '<', no '*')", () => {
    const r = generateReasoning([
      { factor: "timeOfDay", score: 95 },
      { factor: "customerPreference", score: 95 },
      { factor: "lunchAvoidance", score: 60 },
    ]);
    for (const line of r) {
      assert.ok(!line.includes('"'), `unexpected quote in reasoning: ${line}`);
      assert.ok(!line.includes("<"), `unexpected angle bracket: ${line}`);
      assert.ok(!line.includes("**"), `unexpected markdown: ${line}`);
    }
  });
});

// ─── Headline composition ────────────────────────────────────────────

describe("formatHeadlineTime", () => {
  it("formats stably as 'Mon h:mm AM/PM'", () => {
    // 2026-06-15 (Monday in NY)
    const out = formatHeadlineTime(D("2026-06-15T14:00:00Z"), TZ_NY);
    assert.match(out, /^Mon \d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe("buildHeadline", () => {
  const sampleRec: WorkflowRecommendation = {
    time: "2026-06-15T14:00:00Z",
    score: 88,
    labels: ["recommended"],
    reasoning: ["Peak booking hour"],
    deltaMinutes: -180,
    comparison: "earlier",
  };

  it("returns null for empty top", () => {
    const h = buildHeadline({ top: undefined, referenceTime: null, tz: TZ_NY });
    assert.equal(h, null);
  });

  it("returns null when top score < 70", () => {
    const h = buildHeadline({
      top: { ...sampleRec, score: 60 },
      referenceTime: D("2026-06-15T17:00:00Z"),
      tz: TZ_NY,
    });
    assert.equal(h, null);
  });

  it("uses 'Earlier slot available' for earlier comparison", () => {
    const h = buildHeadline({
      top: sampleRec,
      referenceTime: D("2026-06-15T17:00:00Z"),
      tz: TZ_NY,
    });
    assert.ok(h);
    assert.match(h!.text, /Earlier slot available/);
    assert.equal(h!.highlightSlot, sampleRec.time);
  });

  it("uses 'Earliest available' for first_available comparison", () => {
    const h = buildHeadline({
      top: { ...sampleRec, comparison: "first_available" },
      referenceTime: null,
      tz: TZ_NY,
    });
    assert.ok(h);
    assert.match(h!.text, /Earliest available/);
  });

  it("uses 'Same-day option' for same_day comparison", () => {
    const h = buildHeadline({
      top: { ...sampleRec, comparison: "same_day" },
      referenceTime: D("2026-06-15T17:00:00Z"),
      tz: TZ_NY,
    });
    assert.ok(h);
    assert.match(h!.text, /Same-day option/);
  });
});

// ─── promoteRecommendations ──────────────────────────────────────────

describe("promoteRecommendations", () => {
  const scored: ScoredSlot[] = [
    { time: "2026-06-15T14:00:00Z", score: 95, labels: ["recommended"] },
    { time: "2026-06-15T15:00:00Z", score: 85, labels: ["best_availability"] },
    { time: "2026-06-15T16:00:00Z", score: 60, labels: [] },
    { time: "2026-06-15T17:00:00Z", score: 80, labels: [] },
    { time: "2026-06-15T18:00:00Z", score: 70, labels: [] },
  ];

  it("returns at most 3 by default (cap)", () => {
    const out = promoteRecommendations({
      scoredSlots: scored,
      referenceTime: D("2026-06-15T20:00:00Z"),
      tz: TZ_NY,
    });
    assert.equal(out.length, 3);
  });

  it("respects custom limit", () => {
    const out = promoteRecommendations({
      scoredSlots: scored,
      referenceTime: null,
      tz: TZ_NY,
      limit: 2,
    });
    assert.equal(out.length, 2);
  });

  it("sorts by score DESC", () => {
    const out = promoteRecommendations({
      scoredSlots: scored,
      referenceTime: null,
      tz: TZ_NY,
    });
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i - 1].score >= out[i].score, `out of order at ${i}`);
    }
  });

  it("tiebreaks by earlier time", () => {
    const tied: ScoredSlot[] = [
      { time: "2026-06-15T17:00:00Z", score: 80, labels: [] },
      { time: "2026-06-15T14:00:00Z", score: 80, labels: [] },
    ];
    const out = promoteRecommendations({
      scoredSlots: tied,
      referenceTime: null,
      tz: TZ_NY,
    });
    assert.equal(out[0].time, "2026-06-15T14:00:00Z");
  });

  it("computes deltaMinutes against referenceTime", () => {
    const ref = D("2026-06-15T17:00:00Z");
    const out = promoteRecommendations({
      scoredSlots: scored.slice(0, 1),
      referenceTime: ref,
      tz: TZ_NY,
    });
    // 14:00 vs 17:00 = -180 min
    assert.equal(out[0].deltaMinutes, -180);
  });

  it("deltaMinutes is null when no reference time", () => {
    const out = promoteRecommendations({
      scoredSlots: scored.slice(0, 1),
      referenceTime: null,
      tz: TZ_NY,
    });
    assert.equal(out[0].deltaMinutes, null);
  });

  it("returns [] for empty input", () => {
    const out = promoteRecommendations({
      scoredSlots: [],
      referenceTime: null,
      tz: TZ_NY,
    });
    assert.deepEqual(out, []);
  });

  it("is deterministic across calls", () => {
    const a = promoteRecommendations({
      scoredSlots: scored,
      referenceTime: D("2026-06-15T20:00:00Z"),
      tz: TZ_NY,
    });
    const b = promoteRecommendations({
      scoredSlots: scored,
      referenceTime: D("2026-06-15T20:00:00Z"),
      tz: TZ_NY,
    });
    assert.deepEqual(
      a.map((r) => ({ time: r.time, score: r.score, comparison: r.comparison })),
      b.map((r) => ({ time: r.time, score: r.score, comparison: r.comparison })),
    );
  });

  it("first item tagged correctly relative to reference", () => {
    const ref = D("2026-06-15T20:00:00Z");
    const out = promoteRecommendations({
      scoredSlots: scored,
      referenceTime: ref,
      tz: TZ_NY,
    });
    // Top slot is 14:00Z, which is BEFORE ref 20:00Z → "earlier"
    assert.equal(out[0].comparison, "earlier");
  });
});

// ─── Workflow safety contracts ────────────────────────────────────────

describe("workflow safety contracts", () => {
  it("promoteRecommendations does not mutate the input array", () => {
    const input: ScoredSlot[] = [
      { time: "2026-06-15T15:00:00Z", score: 80, labels: [] },
      { time: "2026-06-15T14:00:00Z", score: 95, labels: ["recommended"] },
    ];
    const before = input.map((s) => s.time);
    promoteRecommendations({
      scoredSlots: input,
      referenceTime: null,
      tz: TZ_NY,
    });
    const after = input.map((s) => s.time);
    assert.deepEqual(before, after);
  });

  it("generateReasoning tolerates an empty breakdown array", () => {
    const r = generateReasoning([]);
    assert.ok(r.length >= 1);
  });
});
