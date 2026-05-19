/**
 * Unit tests for lib/analytics/forecasting.ts (pure).
 *
 *   - sparse data → null
 *   - low confidence on short windows
 *   - peak detection only fires when above-mean threshold
 *   - linear projection direction matches trend
 *   - empty/zero handling
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeForecast,
  hasMinimumForecastingHistory,
  _thresholds,
} from "../lib/analytics/forecasting";
import { emptyAggregate, type DailyAggregate } from "../lib/analytics/types";

function makeDay(date: string, overrides: Partial<DailyAggregate> = {}): DailyAggregate {
  return { ...emptyAggregate("t1", date), ...overrides };
}

function makeWindow(days: number, modifier: (i: number) => Partial<DailyAggregate>): DailyAggregate[] {
  const out: DailyAggregate[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(2026, 5, 1 + i);
    out.push(makeDay(d.toISOString().slice(0, 10), modifier(i)));
  }
  return out;
}

describe("forecasting: sparse data", () => {
  it("returns null for < MIN_DAYS_FOR_FORECAST snapshots", () => {
    const tooSparse = makeWindow(_thresholds.MIN_DAYS_FOR_FORECAST - 1, () => ({ totalBookings: 1 }));
    assert.equal(computeForecast(tooSparse), null);
  });
  it("hasMinimumForecastingHistory matches threshold", () => {
    const below = makeWindow(_thresholds.MIN_DAYS_FOR_FORECAST - 1, () => ({}));
    const at = makeWindow(_thresholds.MIN_DAYS_FOR_FORECAST, () => ({}));
    assert.equal(hasMinimumForecastingHistory(below), false);
    assert.equal(hasMinimumForecastingHistory(at), true);
  });
});

describe("forecasting: trend direction", () => {
  it("flat when bookings hover around the mean", () => {
    const flat = makeWindow(14, () => ({ totalBookings: 10 }));
    const r = computeForecast(flat);
    assert.ok(r);
    assert.equal(r.trendDirection, "flat");
  });
  it("up when bookings linearly grow", () => {
    const up = makeWindow(14, (i) => ({ totalBookings: i + 1 }));
    const r = computeForecast(up);
    assert.ok(r);
    assert.equal(r.trendDirection, "up");
  });
  it("down when bookings linearly shrink", () => {
    const down = makeWindow(14, (i) => ({ totalBookings: 20 - i }));
    const r = computeForecast(down);
    assert.ok(r);
    assert.equal(r.trendDirection, "down");
  });
});

describe("forecasting: projection respects last + slope", () => {
  it("up trend projects ABOVE last value", () => {
    const up = makeWindow(14, (i) => ({ totalBookings: 5 + i }));
    const r = computeForecast(up);
    assert.ok(r);
    const last = up[up.length - 1].totalBookings;
    assert.ok(r.projectedBookingsNext30Days >= last, `projected ${r.projectedBookingsNext30Days} should >= last ${last}`);
  });
  it("revenue projects from extras.revenue.netRevenueCents", () => {
    const withRev = makeWindow(14, (i) => ({
      totalBookings: 10,
      extras: { revenue: { grossRevenueCents: 0, refundedRevenueCents: 0, netRevenueCents: 10000 + i * 1000, successfulPayments: 0, failedPayments: 0, avgBookingValueCents: 0 } },
    }));
    const r = computeForecast(withRev);
    assert.ok(r);
    assert.ok(r.projectedRevenueNext30Days > 0);
  });
});

describe("forecasting: confidence scaling", () => {
  it("higher confidence with more days at the same stability", () => {
    const short = makeWindow(_thresholds.MIN_DAYS_FOR_FORECAST, () => ({ totalBookings: 10 }));
    const long = makeWindow(_thresholds.MIN_DAYS_FOR_HIGH_CONFIDENCE * 2, () => ({ totalBookings: 10 }));
    const a = computeForecast(short);
    const b = computeForecast(long);
    assert.ok(a && b);
    assert.ok(b.confidenceScore > a.confidenceScore, `long(${b.confidenceScore}) should > short(${a.confidenceScore})`);
  });
  it("perfectly stable data has near-max confidence at full history", () => {
    const r = computeForecast(makeWindow(30, () => ({ totalBookings: 5 })));
    assert.ok(r);
    assert.ok(r.confidenceScore >= 0.9, `got ${r.confidenceScore}`);
  });
});

describe("forecasting: peak detection", () => {
  it("emits busy weekday when one day clearly dominates", () => {
    const w = makeWindow(14, () => ({
      totalBookings: 10,
      extras: { weekdayDistribution: [0, 0, 0, 0, 0, 30, 0] }, // Fridays = idx 5
    }));
    const r = computeForecast(w);
    assert.ok(r);
    assert.ok(r.expectedBusyWeekdays.includes("Fridays"));
  });
  it("no busy weekday when distribution is flat", () => {
    const w = makeWindow(14, () => ({ totalBookings: 7, extras: { weekdayDistribution: [1, 1, 1, 1, 1, 1, 1] } }));
    const r = computeForecast(w);
    assert.ok(r);
    assert.equal(r.expectedBusyWeekdays.length, 0);
  });
  it("emits peak hours when a few hours clearly dominate", () => {
    const hd = new Array(24).fill(1);
    hd[14] = 20;
    hd[15] = 20;
    const w = makeWindow(14, () => ({ totalBookings: 10, extras: { hourDistribution: hd } }));
    const r = computeForecast(w);
    assert.ok(r);
    assert.ok(r.expectedPeakHours.includes(14));
    assert.ok(r.expectedPeakHours.includes(15));
  });
});

describe("forecasting: staffing pressure", () => {
  it("low when bookings are uniform", () => {
    const r = computeForecast(makeWindow(14, () => ({ totalBookings: 5 })));
    assert.ok(r);
    assert.equal(r.staffingPressureLevel, "low");
  });
  it("medium/high when several days spike well above P75", () => {
    // Sharp spikes interspersed in many flat days so P75 stays low
    // and the spikes clearly exceed P75 * 1.2.
    const w = makeWindow(20, (i) => ({ totalBookings: i % 5 === 0 ? 100 : 1 }));
    const r = computeForecast(w);
    assert.ok(r);
    assert.ok(r.staffingPressureLevel !== "low", `got ${r.staffingPressureLevel}`);
  });
});

describe("forecasting: empty edge cases", () => {
  it("handles zero bookings gracefully", () => {
    const r = computeForecast(makeWindow(14, () => ({ totalBookings: 0 })));
    assert.ok(r);
    assert.equal(r.projectedBookingsNext30Days, 0);
    assert.equal(r.trendDirection, "flat");
  });
});
