/**
 * Phase SMART-1 — slot intelligence tests.
 *
 * Coverage:
 *   • Determinism — same input always produces same output (run
 *     twice, compare structurally).
 *   • Per-factor scorers — every factor's edge cases.
 *   • Composite scoreSlot — weighted total math + breakdown stability.
 *   • rankSlots ordering — output array order matches input order.
 *   • Label assignment — exactly one "recommended"; "best_availability"
 *     only on high-scoring; "fastest_confirmation" on earliest slot.
 *   • Cross-day pickLeastBusyDay — tie handling.
 *   • Focus rule resolver — three-layer precedence (default + tenant
 *     + staff).
 *   • Workload balance — fairness curve below + above soft cap.
 *   • Customer preference signal — kicks in only at sampleSize >= 3.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  scoreSlot,
  scoreTimeOfDay,
  scoreLunchAvoidance,
  scoreEndOfDayFatigue,
  scoreBufferEfficiency,
  scoreBackToBackPenalty,
  scoreFocusBlockRespect,
  scoreWorkloadBalance,
  scoreTimezoneFriendly,
  scoreCustomerPreference,
  scoreDailyDensity,
  hourInTz,
  FACTOR_WEIGHTS,
} from "../lib/scheduling/intelligence/scoreSlot";
import {
  rankSlots,
  pickLeastBusyDay,
} from "../lib/scheduling/intelligence/rankSlots";
import {
  DEFAULT_FOCUS_RULES,
  resolveFocusRules,
  parseFocusRulesFromJson,
} from "../lib/scheduling/intelligence/focusRules";
import type {
  CustomerPreferenceProfile,
  SlotContext,
} from "../lib/scheduling/intelligence/types";

const TZ_NY = "America/New_York";
// 2026-06-15 (Mon) — DST is active. 14:00 UTC = 10:00 EDT.
const D = (iso: string) => new Date(iso);

// ─── Determinism contract ─────────────────────────────────────────────

describe("scoreSlot — determinism", () => {
  const baseCtx: SlotContext = {
    slotStart: D("2026-06-15T14:00:00Z"),
    durationMinutes: 30,
    staffTimezone: TZ_NY,
    workingWindow: {
      start: D("2026-06-15T13:00:00Z"), // 9 EDT
      end: D("2026-06-15T22:00:00Z"),   // 18 EDT
    },
    otherBookings: [],
    staffDailyCount: 2,
    rules: DEFAULT_FOCUS_RULES,
  };

  it("produces identical output across two invocations", () => {
    const a = scoreSlot(baseCtx);
    const b = scoreSlot(baseCtx);
    assert.equal(a.total, b.total);
    assert.deepEqual(
      a.breakdown.map((f) => ({ factor: f.factor, score: f.score })),
      b.breakdown.map((f) => ({ factor: f.factor, score: f.score })),
    );
  });

  it("total stays in [0..100]", () => {
    const s = scoreSlot(baseCtx);
    assert.ok(s.total >= 0 && s.total <= 100, `total=${s.total} out of range`);
  });

  it("returns exactly the 10 expected factors in stable order", () => {
    const s = scoreSlot(baseCtx);
    assert.equal(s.breakdown.length, 10);
    const expected = Object.keys(FACTOR_WEIGHTS);
    assert.deepEqual(
      s.breakdown.map((b) => b.factor),
      expected,
    );
  });

  it("FACTOR_WEIGHTS sum to 100", () => {
    const total = Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
  });
});

// ─── Individual factor scorers ────────────────────────────────────────

describe("scoreTimeOfDay", () => {
  it("peaks around 10:30 local", () => {
    // 14:30 UTC on 2026-06-15 = 10:30 EDT
    const peak = scoreTimeOfDay(D("2026-06-15T14:30:00Z"), TZ_NY);
    // 22:00 UTC = 18:00 EDT
    const late = scoreTimeOfDay(D("2026-06-15T22:00:00Z"), TZ_NY);
    assert.ok(peak.score > late.score, `peak=${peak.score} late=${late.score}`);
  });

  it("clamps at minimum 20 for distant hours", () => {
    // 02:00 UTC = 22:00 EDT prior day → very far from 10:30
    const s = scoreTimeOfDay(D("2026-06-15T02:00:00Z"), TZ_NY);
    assert.ok(s.score >= 20);
  });
});

describe("scoreLunchAvoidance", () => {
  it("100 when slot is outside lunch window", () => {
    // 14:00 UTC = 10:00 EDT — clear of 12-13
    const s = scoreLunchAvoidance(
      D("2026-06-15T14:00:00Z"),
      30,
      DEFAULT_FOCUS_RULES,
      TZ_NY,
    );
    assert.equal(s.score, 100);
  });

  it("60 when slot overlaps lunch", () => {
    // 16:00 UTC = 12:00 EDT — lunch
    const s = scoreLunchAvoidance(
      D("2026-06-15T16:00:00Z"),
      30,
      DEFAULT_FOCUS_RULES,
      TZ_NY,
    );
    assert.equal(s.score, 60);
  });

  it("treats partial overlap as overlap", () => {
    // 16:45 UTC = 12:45 EDT; 30 min duration → ends 13:15 EDT
    // Still overlaps the 12-13 lunch window.
    const s = scoreLunchAvoidance(
      D("2026-06-15T16:45:00Z"),
      30,
      DEFAULT_FOCUS_RULES,
      TZ_NY,
    );
    assert.equal(s.score, 60);
  });
});

describe("scoreEndOfDayFatigue", () => {
  const workingEnd = D("2026-06-15T22:00:00Z"); // 18 EDT

  it("100 when slot is well before EOD", () => {
    const s = scoreEndOfDayFatigue(
      D("2026-06-15T14:00:00Z"),
      30,
      workingEnd,
      DEFAULT_FOCUS_RULES,
    );
    assert.equal(s.score, 100);
  });

  it("decays linearly as slot end approaches working end", () => {
    // 21:30 UTC + 30 min = 22:00 UTC = exactly EOD; full decay.
    const atEnd = scoreEndOfDayFatigue(
      D("2026-06-15T21:30:00Z"),
      30,
      workingEnd,
      DEFAULT_FOCUS_RULES,
    );
    // 21:15 UTC + 30 min = 21:45 UTC; halfway through decay.
    const halfway = scoreEndOfDayFatigue(
      D("2026-06-15T21:15:00Z"),
      30,
      workingEnd,
      DEFAULT_FOCUS_RULES,
    );
    assert.equal(atEnd.score, 50);
    assert.ok(halfway.score > 50 && halfway.score < 100);
  });
});

describe("scoreBufferEfficiency", () => {
  it("100 when no preceding booking", () => {
    const s = scoreBufferEfficiency(D("2026-06-15T14:00:00Z"), [], DEFAULT_FOCUS_RULES);
    assert.equal(s.score, 100);
  });

  it("100 when preceding gap >= minBufferMinutes", () => {
    const s = scoreBufferEfficiency(
      D("2026-06-15T14:00:00Z"),
      [{ start: D("2026-06-15T13:00:00Z"), end: D("2026-06-15T13:30:00Z") }],
      DEFAULT_FOCUS_RULES,
    );
    assert.equal(s.score, 100);
  });

  it("partial credit on tight gaps", () => {
    // 5-minute gap with default minBuffer=10 → ratio 0.5 → 50 + 20 = 70
    const s = scoreBufferEfficiency(
      D("2026-06-15T14:00:00Z"),
      [{ start: D("2026-06-15T13:25:00Z"), end: D("2026-06-15T13:55:00Z") }],
      DEFAULT_FOCUS_RULES,
    );
    assert.ok(s.score > 50 && s.score < 100, `score=${s.score}`);
  });
});

describe("scoreBackToBackPenalty", () => {
  it("100 when total run is within maxConsecutiveHours", () => {
    const s = scoreBackToBackPenalty(
      D("2026-06-15T14:00:00Z"),
      30,
      [{ start: D("2026-06-15T13:30:00Z"), end: D("2026-06-15T14:00:00Z") }],
      DEFAULT_FOCUS_RULES,
    );
    assert.equal(s.score, 100);
  });

  it("penalty when stacking creates overflow", () => {
    // 4.5h of abutting bookings on either side of the slot → over.
    const others: { start: Date; end: Date }[] = [];
    for (let i = 0; i < 5; i++) {
      others.push({
        start: new Date(D("2026-06-15T10:00:00Z").getTime() + i * 60 * 60_000),
        end: new Date(D("2026-06-15T10:00:00Z").getTime() + (i + 1) * 60 * 60_000),
      });
    }
    const s = scoreBackToBackPenalty(
      D("2026-06-15T15:00:00Z"),
      30,
      others,
      DEFAULT_FOCUS_RULES,
    );
    assert.ok(s.score < 100, `expected penalty, got ${s.score}`);
  });
});

describe("scoreFocusBlockRespect", () => {
  it("100 when no quietHours configured", () => {
    const s = scoreFocusBlockRespect(
      D("2026-06-15T14:00:00Z"),
      30,
      DEFAULT_FOCUS_RULES,
      TZ_NY,
    );
    assert.equal(s.score, 100);
  });

  it("heavy penalty when inside a quiet block", () => {
    const rules = {
      ...DEFAULT_FOCUS_RULES,
      quietHours: [{ start: 10, end: 11 }],
    };
    // 14:00 UTC = 10:00 EDT, inside quiet
    const s = scoreFocusBlockRespect(D("2026-06-15T14:00:00Z"), 30, rules, TZ_NY);
    assert.equal(s.score, 20);
  });
});

describe("scoreWorkloadBalance", () => {
  it("100 below soft cap", () => {
    const s = scoreWorkloadBalance(3, DEFAULT_FOCUS_RULES);
    assert.equal(s.score, 100);
  });

  it("decays past the soft cap", () => {
    const at = scoreWorkloadBalance(DEFAULT_FOCUS_RULES.dailySoftCap, DEFAULT_FOCUS_RULES);
    const above = scoreWorkloadBalance(DEFAULT_FOCUS_RULES.dailySoftCap + 2, DEFAULT_FOCUS_RULES);
    assert.ok(at.score <= 100 && above.score < at.score);
    assert.ok(above.score >= 30); // floor enforced
  });
});

describe("scoreTimezoneFriendly", () => {
  it("100 inside customer preferred hours", () => {
    // 14:00 UTC = 10:00 EDT = inside default 9-18
    const s = scoreTimezoneFriendly(
      D("2026-06-15T14:00:00Z"),
      TZ_NY,
      TZ_NY,
      DEFAULT_FOCUS_RULES,
    );
    assert.equal(s.score, 100);
  });

  it("penalizes outside preferred hours", () => {
    // 04:00 UTC = 00:00 EDT — middle of night
    const s = scoreTimezoneFriendly(
      D("2026-06-15T04:00:00Z"),
      TZ_NY,
      TZ_NY,
      DEFAULT_FOCUS_RULES,
    );
    assert.ok(s.score < 100);
    assert.ok(s.score >= 20); // floor
  });
});

describe("scoreCustomerPreference", () => {
  const buildProfile = (overrides: Partial<CustomerPreferenceProfile> = {}): CustomerPreferenceProfile => ({
    preferredHourHistogram: new Array(24).fill(0),
    preferredDayHistogram: new Array(7).fill(0),
    sampleSize: 5,
    rescheduleRate: 0,
    noShowRate: 0,
    ...overrides,
  });

  it("neutral when no profile", () => {
    const s = scoreCustomerPreference(D("2026-06-15T14:00:00Z"), TZ_NY, TZ_NY, undefined);
    assert.equal(s.score, 70);
  });

  it("neutral when sampleSize < 3", () => {
    const profile = buildProfile({ sampleSize: 2 });
    const s = scoreCustomerPreference(D("2026-06-15T14:00:00Z"), TZ_NY, TZ_NY, profile);
    assert.equal(s.score, 70);
  });

  it("rewards customer's most-frequent hour", () => {
    // 14:00 UTC = 10 EDT
    const histogram = new Array(24).fill(0);
    histogram[10] = 8; // strong preference for 10am
    const profile = buildProfile({ preferredHourHistogram: histogram });
    const at10 = scoreCustomerPreference(D("2026-06-15T14:00:00Z"), TZ_NY, TZ_NY, profile);
    const at15 = scoreCustomerPreference(D("2026-06-15T19:00:00Z"), TZ_NY, TZ_NY, profile); // 15 EDT
    assert.ok(at10.score > at15.score);
    assert.ok(at10.score >= 90);
  });

  it("softens preference signal for flaky customers", () => {
    const histogram = new Array(24).fill(0);
    histogram[10] = 8;
    const reliable = buildProfile({ preferredHourHistogram: histogram });
    const flaky = buildProfile({
      preferredHourHistogram: histogram,
      rescheduleRate: 0.5,
      noShowRate: 0.5,
    });
    const a = scoreCustomerPreference(D("2026-06-15T14:00:00Z"), TZ_NY, TZ_NY, reliable);
    const b = scoreCustomerPreference(D("2026-06-15T14:00:00Z"), TZ_NY, TZ_NY, flaky);
    // Reliability factor pulls flaky score toward the 70 baseline.
    assert.ok(b.score < a.score);
  });
});

describe("scoreDailyDensity", () => {
  it("100 light day", () => {
    assert.equal(scoreDailyDensity(2, DEFAULT_FOCUS_RULES).score, 100);
  });
  it("80 moderate", () => {
    assert.equal(scoreDailyDensity(5, DEFAULT_FOCUS_RULES).score, 80);
  });
  it("55 busy", () => {
    assert.equal(scoreDailyDensity(9, DEFAULT_FOCUS_RULES).score, 55);
  });
  it("30 overloaded", () => {
    assert.equal(scoreDailyDensity(20, DEFAULT_FOCUS_RULES).score, 30);
  });
});

// ─── rankSlots — ordering + labels ────────────────────────────────────

describe("rankSlots — ordering + labels", () => {
  const slots = [
    "2026-06-15T13:00:00Z", // 9 EDT
    "2026-06-15T14:00:00Z", // 10 EDT — best time-of-day
    "2026-06-15T15:00:00Z", // 11 EDT
    "2026-06-15T16:00:00Z", // 12 EDT — lunch
    "2026-06-15T17:00:00Z", // 13 EDT
  ];

  const base = {
    slots,
    durationMinutes: 30,
    staffTimezone: TZ_NY,
    workingWindow: {
      start: D("2026-06-15T13:00:00Z"),
      end: D("2026-06-15T22:00:00Z"),
    },
    otherBookings: [],
    staffDailyCount: 2,
    rules: DEFAULT_FOCUS_RULES,
  };

  it("preserves input order in output", () => {
    const out = rankSlots(base);
    assert.deepEqual(out.map((s) => s.time), slots);
  });

  it("assigns exactly one 'recommended' label", () => {
    const out = rankSlots(base);
    const rec = out.filter((s) => s.labels.includes("recommended"));
    assert.equal(rec.length, 1);
  });

  it("'fastest_confirmation' lands on the earliest slot when score is decent", () => {
    const out = rankSlots(base);
    assert.ok(out[0].labels.includes("fastest_confirmation"));
  });

  it("is deterministic across calls", () => {
    const a = rankSlots(base);
    const b = rankSlots(base);
    assert.deepEqual(a.map((s) => s.labels), b.map((s) => s.labels));
    assert.deepEqual(a.map((s) => s.score), b.map((s) => s.score));
  });

  it("returns [] for empty input", () => {
    const out = rankSlots({ ...base, slots: [] });
    assert.deepEqual(out, []);
  });
});

describe("pickLeastBusyDay", () => {
  it("returns null when there's a true tie", () => {
    const result = pickLeastBusyDay([
      { date: "2026-06-15", slots: [{ time: "x", score: 80, labels: [] }] },
      { date: "2026-06-16", slots: [{ time: "y", score: 80, labels: [] }] },
    ]);
    assert.equal(result, null);
  });

  it("returns the highest-mean-score day", () => {
    const result = pickLeastBusyDay([
      { date: "2026-06-15", slots: [{ time: "x", score: 60, labels: [] }] },
      { date: "2026-06-16", slots: [{ time: "y", score: 90, labels: [] }] },
    ]);
    assert.equal(result, "2026-06-16");
  });

  it("returns null when fewer than 2 days", () => {
    const result = pickLeastBusyDay([
      { date: "2026-06-15", slots: [{ time: "x", score: 80, labels: [] }] },
    ]);
    assert.equal(result, null);
  });
});

// ─── Focus rule resolver ──────────────────────────────────────────────

describe("resolveFocusRules", () => {
  it("defaults when both tenant + staff are null", () => {
    const r = resolveFocusRules({ tenantRules: null, staffRules: null });
    assert.deepEqual(r, DEFAULT_FOCUS_RULES);
  });

  it("staff overrides tenant overrides default", () => {
    const r = resolveFocusRules({
      tenantRules: { dailySoftCap: 6 },
      staffRules: { dailySoftCap: 4 },
    });
    assert.equal(r.dailySoftCap, 4);
    // Tenant kept other defaults; staff didn't touch them.
    assert.equal(r.minBufferMinutes, DEFAULT_FOCUS_RULES.minBufferMinutes);
  });

  it("tenant overrides default, staff inherits tenant", () => {
    const r = resolveFocusRules({
      tenantRules: { dailySoftCap: 6, lunchHours: { start: 13, end: 14 } },
      staffRules: null,
    });
    assert.equal(r.dailySoftCap, 6);
    assert.equal(r.lunchHours.start, 13);
  });

  it("parseFocusRulesFromJson rejects garbage", () => {
    assert.equal(parseFocusRulesFromJson(null), null);
    assert.equal(parseFocusRulesFromJson(undefined), null);
    assert.equal(parseFocusRulesFromJson("not-an-object"), null);
    assert.equal(parseFocusRulesFromJson(123), null);
  });

  it("parseFocusRulesFromJson accepts a partial object + ignores bad fields", () => {
    const r = parseFocusRulesFromJson({
      dailySoftCap: 5,
      lunchHours: { start: "bad", end: 13 }, // start is wrong type
    });
    assert.deepEqual(r, { dailySoftCap: 5 });
  });
});

// ─── Timezone helper ──────────────────────────────────────────────────

describe("hourInTz", () => {
  it("returns local hour in the given timezone", () => {
    // 14:00 UTC = 10:00 EDT (June, DST active)
    assert.equal(hourInTz(D("2026-06-15T14:00:00Z"), TZ_NY), 10);
    // 14:00 UTC = 09:00 EST (January, no DST)
    assert.equal(hourInTz(D("2026-01-15T14:00:00Z"), TZ_NY), 9);
  });
});
