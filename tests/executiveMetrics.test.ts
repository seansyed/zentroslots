/**
 * Unit tests for lib/analytics/executiveMetrics.ts + comparisons.ts +
 * scheduledReports.ts composer (pure).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildExecutiveSummary } from "../lib/analytics/executiveMetrics";
import {
  compareWindows,
  compareWeekdays,
  splitForComparison,
  _thresholds as cmpThresholds,
} from "../lib/analytics/comparisons";
import {
  composeScheduledReportBody,
  periodBoundsFor,
} from "../lib/analytics/scheduledReports";
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

// ─── comparisons ─────────────────────────────────────────────────────

describe("comparisons: splitForComparison", () => {
  it("returns null for windows shorter than 2 × indicative", () => {
    assert.equal(splitForComparison(window(13, () => ({}))), null);
  });
  it("splits 14 days into 7 prior + 7 current", () => {
    const r = splitForComparison(window(14, () => ({})));
    assert.ok(r);
    assert.equal(r.previous.length, 7);
    assert.equal(r.current.length, 7);
  });
  it("splits 30 days into 15 + 15", () => {
    const r = splitForComparison(window(30, () => ({})));
    assert.ok(r);
    assert.equal(r.previous.length, 15);
    assert.equal(r.current.length, 15);
  });
});

describe("comparisons: compareWindows", () => {
  it("returns 0 change for equal windows", () => {
    const w = window(14, () => ({ totalBookings: 5 }));
    const split = splitForComparison(w)!;
    const r = compareWindows(split.current, split.previous, (s) => s.totalBookings);
    assert.equal(r.percentChange, 0);
  });
  it("handles previous=0 with current>0 as +100%", () => {
    const cur = window(7, () => ({ totalBookings: 10 }));
    const prev = window(7, () => ({ totalBookings: 0 }));
    const r = compareWindows(cur, prev, (s) => s.totalBookings);
    assert.equal(r.percentChange, 100);
  });
  it("handles both zero as 0%", () => {
    const r = compareWindows(window(7, () => ({})), window(7, () => ({})), (s) => s.totalBookings);
    assert.equal(r.percentChange, 0);
  });
  it("computes negative change for shrinking windows", () => {
    const cur = window(7, () => ({ totalBookings: 5 }));
    const prev = window(7, () => ({ totalBookings: 10 }));
    const r = compareWindows(cur, prev, (s) => s.totalBookings);
    assert.equal(r.percentChange, -50);
  });
  it("quality is reliable on long stable windows", () => {
    const w = window(cmpThresholds.RELIABLE_MIN_DAYS * 2, () => ({ totalBookings: 10 }));
    const split = splitForComparison(w)!;
    const r = compareWindows(split.current, split.previous, (s) => s.totalBookings);
    assert.equal(r.quality, "reliable");
  });
  it("quality is noisy when CV > threshold", () => {
    const w = window(30, (i) => ({ totalBookings: i % 2 === 0 ? 100 : 1 }));
    const split = splitForComparison(w)!;
    const r = compareWindows(split.current, split.previous, (s) => s.totalBookings);
    assert.equal(r.quality, "noisy");
  });
});

describe("comparisons: compareWeekdays", () => {
  it("ratio to mean of 1 when distribution is flat", () => {
    const w = window(7, () => ({ extras: { weekdayDistribution: [1, 1, 1, 1, 1, 1, 1] } }));
    const result = compareWeekdays(w);
    for (const r of result) {
      assert.equal(r.ratioToMean, 1);
    }
  });
  it("ratio > 1 for dominant weekday", () => {
    const w = window(7, () => ({
      extras: { weekdayDistribution: [0, 0, 0, 0, 0, 10, 0] }, // Fridays
    }));
    const result = compareWeekdays(w);
    assert.ok(result[5].ratioToMean > 1);
    assert.equal(result[5].bookings, 70);
  });
});

// ─── executiveMetrics ───────────────────────────────────────────────

describe("executiveMetrics: null on sparse data", () => {
  it("returns null when window < 14 days", () => {
    const r = buildExecutiveSummary(window(10, () => ({ totalBookings: 5 })));
    assert.equal(r, null);
  });
});

describe("executiveMetrics: KPI computation", () => {
  it("computes bookings KPI with up trend on growing data", () => {
    const w = window(20, (i) => ({ totalBookings: i + 1 }));
    const r = buildExecutiveSummary(w);
    assert.ok(r);
    assert.equal(r.bookings.trendDirection, "up");
    assert.ok(r.bookings.comparison.currentValue > r.bookings.comparison.previousValue);
  });

  it("flags flat trend within ±3%", () => {
    const w = window(20, () => ({ totalBookings: 10 }));
    const r = buildExecutiveSummary(w);
    assert.ok(r);
    assert.equal(r.bookings.trendDirection, "flat");
  });

  it("revenue KPI reads from extras.revenue.netRevenueCents", () => {
    const w = window(20, (i) => ({
      totalBookings: 5,
      extras: {
        revenue: {
          grossRevenueCents: 0,
          refundedRevenueCents: 0,
          netRevenueCents: 1000 + i * 100,
          successfulPayments: 0,
          failedPayments: 0,
          avgBookingValueCents: 0,
        },
      },
    }));
    const r = buildExecutiveSummary(w);
    assert.ok(r);
    assert.equal(r.revenue.trendDirection, "up");
  });

  it("repeat customer % comes from the supplied data hook", () => {
    const w = window(20, () => ({ totalBookings: 5 }));
    const r = buildExecutiveSummary(w, {
      currentRepeat: 30,
      currentTotal: 100,
      prevRepeat: 20,
      prevTotal: 100,
    });
    assert.ok(r);
    assert.equal(r.repeatCustomerPct.comparison.currentValue, 30);
    assert.equal(r.repeatCustomerPct.comparison.previousValue, 20);
    assert.equal(r.repeatCustomerPct.comparison.percentChange, 50);
  });

  it("confidence reasonable on stable history", () => {
    const w = window(30, () => ({ totalBookings: 10 }));
    const r = buildExecutiveSummary(w);
    assert.ok(r);
    assert.ok(r.confidence >= 0.7, `got ${r.confidence}`);
  });
});

// ─── scheduledReports composer ──────────────────────────────────────

describe("scheduledReports: composer", () => {
  it("emits zero totals on empty current period", () => {
    const body = composeScheduledReportBody({
      periodType: "weekly",
      periodStart: "2026-05-01",
      periodEnd: "2026-05-07",
      windowWithPriorPeriod: [],
      currentPeriodSnapshots: [],
    });
    assert.equal(body.totals.bookings, 0);
    assert.equal(body.totals.netRevenueCents, 0);
    assert.equal(body.executive, null);
    assert.equal(body.forecasting, null);
  });

  it("sums totals from current-period snapshots", () => {
    const cur = window(7, () => ({
      totalBookings: 3,
      completedBookings: 2,
      cancelledBookings: 1,
      extras: {
        revenue: {
          grossRevenueCents: 5000,
          refundedRevenueCents: 0,
          netRevenueCents: 5000,
          successfulPayments: 1,
          failedPayments: 0,
          avgBookingValueCents: 5000,
        },
      },
    }));
    const body = composeScheduledReportBody({
      periodType: "weekly",
      periodStart: cur[0].snapshotDate,
      periodEnd: cur[cur.length - 1].snapshotDate,
      windowWithPriorPeriod: cur,
      currentPeriodSnapshots: cur,
    });
    assert.equal(body.totals.bookings, 21);
    assert.equal(body.totals.completed, 14);
    assert.equal(body.totals.grossRevenueCents, 35000);
  });

  it("attaches forecasting from latest snapshot when present", () => {
    const cur = window(7, () => ({}));
    cur[cur.length - 1].extras.forecasting = {
      projectedBookingsNext30Days: 100,
      projectedRevenueNext30Days: 0,
      expectedBusyWeekdays: [],
      expectedPeakHours: [],
      staffingPressureLevel: "low",
      trendDirection: "flat",
      confidenceScore: 0.7,
      basedOnDays: 7,
    };
    const body = composeScheduledReportBody({
      periodType: "weekly",
      periodStart: cur[0].snapshotDate,
      periodEnd: cur[cur.length - 1].snapshotDate,
      windowWithPriorPeriod: cur,
      currentPeriodSnapshots: cur,
    });
    assert.ok(body.forecasting);
    assert.equal(body.forecasting.projectedBookingsNext30Days, 100);
  });
});

describe("scheduledReports: periodBoundsFor", () => {
  const anchor = new Date("2026-06-15T00:00:00Z");
  it("daily is single day", () => {
    const b = periodBoundsFor("daily", anchor);
    assert.equal(b.days, 1);
    assert.equal(b.start.getTime(), b.end.getTime());
  });
  it("weekly is 7 days inclusive end", () => {
    const b = periodBoundsFor("weekly", anchor);
    assert.equal(b.days, 7);
    assert.equal(b.end.getUTCDate(), 15);
    assert.equal(b.start.getUTCDate(), 9);
  });
  it("monthly is 30 days", () => {
    const b = periodBoundsFor("monthly", anchor);
    assert.equal(b.days, 30);
  });
});
