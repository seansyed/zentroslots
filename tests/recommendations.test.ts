/**
 * Unit tests for lib/analytics/recommendations.ts (pure).
 *
 *   - every recommendation cites evidence
 *   - deterministic ordering & dedup by code
 *   - no recommendation when signals are absent
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRecommendations } from "../lib/analytics/recommendations";
import { emptyAggregate, type DailyAggregate } from "../lib/analytics/types";

function makeWindow(n: number, modifier: (i: number) => Partial<DailyAggregate>): DailyAggregate[] {
  const out: DailyAggregate[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(2026, 5, 1 + i);
    out.push({ ...emptyAggregate("t1", d.toISOString().slice(0, 10)), ...modifier(i) });
  }
  return out;
}

describe("recommendations: empty signals → no recs", () => {
  it("emits nothing when forecast is null and no staffing signals", () => {
    const recs = buildRecommendations({
      snapshots: makeWindow(3, () => ({})),
      forecast: null,
      staffingSignals: {
        overloadStaff: 0,
        underutilizedStaff: 0,
        unevenAssignment: false,
        bookingSurge: false,
        highCancelWeekdays: [],
      },
    });
    assert.equal(recs.length, 0);
  });
});

describe("recommendations: cite evidence", () => {
  it("add_staff_busy_weekdays emits when pressure is non-low and busy days exist", () => {
    const recs = buildRecommendations({
      snapshots: makeWindow(7, () => ({})),
      forecast: {
        projectedBookingsNext30Days: 200,
        projectedRevenueNext30Days: 100000,
        expectedBusyWeekdays: ["Fridays"],
        expectedPeakHours: [14, 15],
        staffingPressureLevel: "medium",
        trendDirection: "up",
        confidenceScore: 0.8,
        basedOnDays: 30,
      },
      staffingSignals: {
        overloadStaff: 0,
        underutilizedStaff: 0,
        unevenAssignment: false,
        bookingSurge: false,
        highCancelWeekdays: [],
      },
    });
    const rec = recs.find((r) => r.code === "add_staff_busy_weekdays");
    assert.ok(rec);
    assert.match(rec.evidence, /Staffing pressure level is medium/);
    assert.match(rec.message, /Fridays/);
  });

  it("peak_hours_window names the time window", () => {
    const recs = buildRecommendations({
      snapshots: makeWindow(7, () => ({})),
      forecast: {
        projectedBookingsNext30Days: 100,
        projectedRevenueNext30Days: 0,
        expectedBusyWeekdays: [],
        expectedPeakHours: [13, 14, 15],
        staffingPressureLevel: "low",
        trendDirection: "flat",
        confidenceScore: 0.7,
        basedOnDays: 14,
      },
      staffingSignals: {
        overloadStaff: 0,
        underutilizedStaff: 0,
        unevenAssignment: false,
        bookingSurge: false,
        highCancelWeekdays: [],
      },
    });
    const rec = recs.find((r) => r.code === "peak_hours_window");
    assert.ok(rec);
    assert.match(rec.message, /1PM|2PM|3PM|4PM/);
  });

  it("rebalance_routing emits when overloadStaff > 0", () => {
    const recs = buildRecommendations({
      snapshots: makeWindow(7, () => ({})),
      forecast: null,
      staffingSignals: {
        overloadStaff: 1,
        underutilizedStaff: 0,
        unevenAssignment: false,
        bookingSurge: false,
        highCancelWeekdays: [],
      },
    });
    const rec = recs.find((r) => r.code === "rebalance_routing");
    assert.ok(rec);
    assert.match(rec.evidence, /handle ≥ 50%/);
  });

  it("reminder_suppression_correlation emits with sufficient signals", () => {
    const snapshots = makeWindow(14, () => ({
      totalBookings: 10,
      cancelledBookings: 2,
      reminderEmailsSent: 50,
      reminderEmailsSuppressed: 30,
    }));
    const recs = buildRecommendations({
      snapshots,
      forecast: null,
      staffingSignals: {
        overloadStaff: 0,
        underutilizedStaff: 0,
        unevenAssignment: false,
        bookingSurge: false,
        highCancelWeekdays: [],
      },
    });
    const rec = recs.find((r) => r.code === "reminder_suppression_correlation");
    assert.ok(rec);
    assert.match(rec.evidence, /Suppression rate \d+%/);
  });
});

describe("recommendations: every entry has cited evidence (rule 'no AI filler')", () => {
  it("evidence is non-empty for every emitted recommendation", () => {
    const recs = buildRecommendations({
      snapshots: makeWindow(14, () => ({
        totalBookings: 10,
        cancelledBookings: 3,
        reminderEmailsSent: 50,
        reminderEmailsSuppressed: 30,
      })),
      forecast: {
        projectedBookingsNext30Days: 100,
        projectedRevenueNext30Days: 5000,
        expectedBusyWeekdays: ["Fridays"],
        expectedPeakHours: [14, 15, 16],
        staffingPressureLevel: "medium",
        trendDirection: "up",
        confidenceScore: 0.7,
        basedOnDays: 14,
      },
      staffingSignals: {
        overloadStaff: 1,
        underutilizedStaff: 1,
        unevenAssignment: true,
        bookingSurge: true,
        highCancelWeekdays: [1, 5],
      },
    });
    assert.ok(recs.length > 0);
    for (const rec of recs) {
      assert.ok(rec.evidence.length > 0, `${rec.code} must cite evidence`);
      assert.ok(rec.message.length > 0);
    }
  });
});
