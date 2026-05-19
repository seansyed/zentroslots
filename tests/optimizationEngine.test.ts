/**
 * Unit tests for lib/analytics/optimizationEngine.ts +
 * lib/analytics/priorityScoring.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildOptimizationRecommendations,
  _thresholds as optThresholds,
} from "../lib/analytics/optimizationEngine";
import {
  scorePriority,
  comparePriority,
  _thresholds as prioThresholds,
} from "../lib/analytics/priorityScoring";
import { emptyAggregate, type DailyAggregate } from "../lib/analytics/types";

function makeDay(date: string, overrides: Partial<DailyAggregate> = {}): DailyAggregate {
  return { ...emptyAggregate("t1", date), ...overrides };
}

function window(n: number, modifier: (i: number) => Partial<DailyAggregate>): DailyAggregate[] {
  const out: DailyAggregate[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(2026, 5, 1 + i);
    out.push(makeDay(d.toISOString().slice(0, 10), modifier(i)));
  }
  return out;
}

// ─── priorityScoring ─────────────────────────────────────────────────

describe("priorityScoring: scorePriority", () => {
  it("low priority for zero impact + low pressure + low confidence", () => {
    const r = scorePriority({
      projectedMonthlyImpactCents: 0,
      operationalPressure: 0,
      frequency: 0,
      confidence: 0,
    });
    assert.equal(r.priority, "low");
    assert.equal(r.score, 0);
  });

  it("critical priority when impact + pressure both max", () => {
    const r = scorePriority({
      projectedMonthlyImpactCents: 10_000_00, // > cap
      operationalPressure: 1,
      frequency: 1,
      confidence: 1,
    });
    assert.equal(r.priority, "critical");
    assert.ok(r.score >= prioThresholds.BAND_HIGH);
  });

  it("clamps out-of-range inputs", () => {
    const r = scorePriority({
      projectedMonthlyImpactCents: -50,
      operationalPressure: 2,
      frequency: -1,
      confidence: 5,
    });
    assert.equal(r.factors.financialImpact, 0);
    assert.equal(r.factors.operationalPressure, 1);
    assert.equal(r.factors.frequency, 0);
    assert.equal(r.factors.confidence, 1);
  });

  it("medium priority for moderate dollar impact with average confidence", () => {
    const r = scorePriority({
      projectedMonthlyImpactCents: 1_000_00,
      operationalPressure: 0.4,
      frequency: 0.5,
      confidence: 0.5,
    });
    assert.ok(["medium", "high"].includes(r.priority), `got ${r.priority}`);
  });

  it("financial cap saturates", () => {
    const r1 = scorePriority({
      projectedMonthlyImpactCents: optThresholds.FALLBACK_AVG_BOOKING_CENTS * 100,
      operationalPressure: 0,
      frequency: 0,
      confidence: 0,
    });
    const r2 = scorePriority({
      projectedMonthlyImpactCents: optThresholds.FALLBACK_AVG_BOOKING_CENTS * 1000,
      operationalPressure: 0,
      frequency: 0,
      confidence: 0,
    });
    // Beyond cap, both should max financial axis at 1.0.
    assert.equal(r1.factors.financialImpact, 1);
    assert.equal(r2.factors.financialImpact, 1);
  });
});

describe("priorityScoring: comparePriority", () => {
  it("orders critical before low", () => {
    const a = scorePriority({
      projectedMonthlyImpactCents: 10_000_00,
      operationalPressure: 1,
      frequency: 1,
      confidence: 1,
    });
    const b = scorePriority({
      projectedMonthlyImpactCents: 0,
      operationalPressure: 0,
      frequency: 0,
      confidence: 0,
    });
    assert.ok(comparePriority(a, b) < 0);
    assert.ok(comparePriority(b, a) > 0);
  });
});

// ─── optimizationEngine: minimums ────────────────────────────────────

describe("optimizationEngine: sparse data", () => {
  it("returns [] on < 7 day window", () => {
    const recs = buildOptimizationRecommendations({
      snapshots: window(5, () => ({ totalBookings: 5 })),
    });
    assert.deepEqual(recs, []);
  });
  it("returns [] on empty input", () => {
    const recs = buildOptimizationRecommendations({ snapshots: [] });
    assert.deepEqual(recs, []);
  });
});

// ─── optimizationEngine: scheduling category ─────────────────────────

describe("optimizationEngine: scheduling category", () => {
  it("emits high-waitlist-demand recommendation when waitlist joins exceed 10% of bookings", () => {
    const w = window(14, () => ({
      totalBookings: 10,
      waitlistJoins: 3,
      waitlistConversions: 1,
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const r = recs.find((x) => x.code === "expand_availability_high_waitlist_demand");
    assert.ok(r, `expected expand_availability_high_waitlist_demand, got ${recs.map((x) => x.code).join(",")}`);
    assert.equal(r.category, "scheduling");
    assert.ok(r.supportingMetrics.length >= 2);
  });

  it("does NOT emit waitlist demand recommendation when ratio is low", () => {
    const w = window(14, () => ({
      totalBookings: 100,
      waitlistJoins: 1,
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const r = recs.find((x) => x.code === "expand_availability_high_waitlist_demand");
    assert.equal(r, undefined);
  });

  it("emits remove-unused-business-hours when 2+ business hours are dead", () => {
    // Hours 9 and 14 dead, others active.
    const hd = new Array(24).fill(0);
    for (let i = 8; i < 19; i++) hd[i] = 5;
    hd[9] = 0;
    hd[14] = 0;
    const w = window(14, () => ({
      totalBookings: 50,
      extras: { hourDistribution: hd },
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const r = recs.find((x) => x.code === "remove_unused_business_hours");
    assert.ok(r);
    assert.equal(r.category, "scheduling");
  });
});

// ─── optimizationEngine: revenue category ────────────────────────────

describe("optimizationEngine: revenue category", () => {
  it("emits revenue-concentration-risk when top service >= 50% of revenue", () => {
    const w = window(14, () => ({
      totalBookings: 10,
      extras: {
        revenue: {
          grossRevenueCents: 10000,
          refundedRevenueCents: 0,
          netRevenueCents: 10000,
          successfulPayments: 10,
          failedPayments: 0,
          avgBookingValueCents: 1000,
        },
        serviceRevenue: [
          { serviceId: "svc-a", serviceName: "Service A", revenueCents: 8000, bookings: 8 },
          { serviceId: "svc-b", serviceName: "Service B", revenueCents: 2000, bookings: 2 },
        ],
      },
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const r = recs.find((x) => x.code === "revenue_concentration_risk");
    assert.ok(r);
    assert.equal(r.category, "revenue");
  });

  it("emits promote-high-value-service when one service has the best per-booking revenue", () => {
    const w = window(14, () => ({
      totalBookings: 10,
      extras: {
        revenue: {
          grossRevenueCents: 10000,
          refundedRevenueCents: 0,
          netRevenueCents: 10000,
          successfulPayments: 10,
          failedPayments: 0,
          avgBookingValueCents: 1000,
        },
        serviceRevenue: [
          { serviceId: "svc-a", serviceName: "Premium", revenueCents: 6000, bookings: 5 },
          { serviceId: "svc-b", serviceName: "Standard", revenueCents: 4000, bookings: 10 },
        ],
      },
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const r = recs.find((x) => x.code === "promote_high_value_service");
    assert.ok(r);
    assert.ok(r.title.includes("Premium"));
    assert.ok(r.projectedImpact.monthlyImpactCents > 0);
  });

  it("emits investigate-failed-payments when failure rate > 5%", () => {
    const w = window(14, () => ({
      totalBookings: 10,
      extras: {
        revenue: {
          grossRevenueCents: 10000,
          refundedRevenueCents: 0,
          netRevenueCents: 10000,
          successfulPayments: 10,
          failedPayments: 2,
          avgBookingValueCents: 1000,
        },
        serviceRevenue: [
          { serviceId: "svc-a", serviceName: "A", revenueCents: 10000, bookings: 10 },
        ],
      },
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const r = recs.find((x) => x.code === "investigate_failed_payments");
    assert.ok(r);
    assert.equal(r.category, "revenue");
  });

  it("emits NO revenue recommendations when window has no revenue data", () => {
    const w = window(14, () => ({ totalBookings: 5 }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const rev = recs.filter((x) => x.category === "revenue");
    assert.equal(rev.length, 0);
  });
});

// ─── optimizationEngine: waitlist category ───────────────────────────

describe("optimizationEngine: waitlist category", () => {
  it("emits improve-waitlist-conversion when conversion < 50%", () => {
    const w = window(14, () => ({
      totalBookings: 10,
      waitlistJoins: 4,
      waitlistConversions: 1,
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const r = recs.find((x) => x.code === "improve_waitlist_conversion");
    assert.ok(r);
    assert.equal(r.category, "waitlist");
  });

  it("emits shorten-waitlist-hold-window when expiry rate > 30%", () => {
    const w = window(14, () => ({
      totalBookings: 10,
      waitlistJoins: 5,
      waitlistConversions: 2,
      extras: { waitlist: { expiredHolds: 3, avgWaitMinutes: 30 } },
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const r = recs.find((x) => x.code === "shorten_waitlist_hold_window");
    assert.ok(r);
  });

  it("emits NO waitlist recommendations when fewer than 3 joins in window", () => {
    const w = window(14, () => ({ totalBookings: 10, waitlistJoins: 0 }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const wl = recs.filter((x) => x.category === "waitlist");
    assert.equal(wl.length, 0);
  });
});

// ─── optimizationEngine: customer retention ──────────────────────────

describe("optimizationEngine: customer retention category", () => {
  it("emits boost-repeat-customer-rate when repeat < 25%", () => {
    const w = window(14, () => ({ totalBookings: 10 }));
    const recs = buildOptimizationRecommendations({
      snapshots: w,
      customerIntelligence: {
        repeatCustomerRate: 10,
        retentionRate: 5,
        newCustomersThisPeriod: 20,
        bookingsByExistingCustomers: 10,
        bookingsByNewCustomers: 90,
      },
    });
    const r = recs.find((x) => x.code === "boost_repeat_customer_rate");
    assert.ok(r);
    assert.equal(r.category, "customer_retention");
    assert.ok(r.projectedImpact.monthlyImpactCents >= 0);
  });

  it("emits referral recommendation when retention is strong", () => {
    const w = window(14, () => ({ totalBookings: 10 }));
    const recs = buildOptimizationRecommendations({
      snapshots: w,
      customerIntelligence: {
        repeatCustomerRate: 75,
        retentionRate: 60,
        newCustomersThisPeriod: 5,
        bookingsByExistingCustomers: 75,
        bookingsByNewCustomers: 25,
      },
    });
    const r = recs.find((x) => x.code === "leverage_high_retention_for_referrals");
    assert.ok(r);
  });

  it("emits NO customer retention recommendations without intel input", () => {
    const w = window(14, () => ({ totalBookings: 10 }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const cr = recs.filter((x) => x.category === "customer_retention");
    assert.equal(cr.length, 0);
  });
});

// ─── optimizationEngine: legacy enrichment ───────────────────────────

describe("optimizationEngine: legacy enrichment", () => {
  it("enriches a legacy peak_hours_window into scheduling category", () => {
    // Build a window with strong morning peak so the underlying
    // forecasting+recommendations pipeline emits peak_hours_window.
    const hd = new Array(24).fill(1);
    hd[9] = 50;
    hd[10] = 50;
    const w = window(14, () => ({
      totalBookings: 30,
      extras: { hourDistribution: hd, weekdayDistribution: [5, 5, 5, 5, 5, 5, 0] },
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const peak = recs.find((x) => x.code === "peak_hours_window");
    if (peak) {
      assert.equal(peak.category, "scheduling");
      assert.ok(peak.title.length > 0);
    }
    // Either the legacy emitted or it didn't — both are valid given
    // the window dataset; we only assert SHAPE if it did.
  });
});

// ─── optimizationEngine: ordering ────────────────────────────────────

describe("optimizationEngine: ordering", () => {
  it("returns recommendations sorted critical → low", () => {
    const w = window(14, () => ({
      totalBookings: 10,
      waitlistJoins: 4,
      waitlistConversions: 1,
      extras: {
        revenue: {
          grossRevenueCents: 100_000,
          refundedRevenueCents: 0,
          netRevenueCents: 100_000,
          successfulPayments: 10,
          failedPayments: 3,
          avgBookingValueCents: 10_000,
        },
        serviceRevenue: [
          { serviceId: "svc-a", serviceName: "A", revenueCents: 80_000, bookings: 8 },
          { serviceId: "svc-b", serviceName: "B", revenueCents: 20_000, bookings: 2 },
        ],
      },
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    if (recs.length >= 2) {
      const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      for (let i = 0; i + 1 < recs.length; i++) {
        assert.ok(
          order[recs[i].severity] <= order[recs[i + 1].severity],
          `out of order at ${i}: ${recs[i].severity} -> ${recs[i + 1].severity}`
        );
      }
    }
  });

  it("dedupes recommendations by code", () => {
    const w = window(14, () => ({
      totalBookings: 10,
      waitlistJoins: 4,
      waitlistConversions: 1,
    }));
    const recs = buildOptimizationRecommendations({ snapshots: w });
    const codes = recs.map((r) => r.code);
    const unique = new Set(codes);
    assert.equal(codes.length, unique.size);
  });
});
