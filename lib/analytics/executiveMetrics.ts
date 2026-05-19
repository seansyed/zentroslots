/**
 * Executive KPI engine — pure deterministic math over snapshot windows.
 *
 * Computes a closed set of business KPIs comparing the current period
 * to the equal-length prior period. Every metric returns a Comparison
 * struct with currentValue / previousValue / percentChange / quality.
 *
 * The dashboard uses these to render growth indicators with trend
 * direction. Numbers above derive from the SAME snapshot extras the
 * existing aggregation populates — no separate read path.
 */
import { compareWindows, splitForComparison, type Comparison } from "./comparisons";
import type { DailyAggregate } from "./types";

export type ExecutiveTrend = "up" | "down" | "flat";

export type ExecutiveKPI = {
  comparison: Comparison;
  trendDirection: ExecutiveTrend;
};

export type ExecutiveSummary = {
  bookings: ExecutiveKPI;
  revenue: ExecutiveKPI;
  cancellations: ExecutiveKPI;
  waitlistConversions: ExecutiveKPI;
  avgBookingValue: ExecutiveKPI;
  repeatCustomerPct: ExecutiveKPI;
  staffEfficiency: ExecutiveKPI;
  /** 0..1 — confidence in the overall summary. Lower with sparse data. */
  confidence: number;
  /** Days in current period (== prior period). */
  periodDays: number;
};

// ─── Trend bands ─────────────────────────────────────────────────────

const FLAT_BAND_PCT = 3; // |%change| ≤ 3 → flat

function directionFor(percent: number): ExecutiveTrend {
  if (percent > FLAT_BAND_PCT) return "up";
  if (percent < -FLAT_BAND_PCT) return "down";
  return "flat";
}

function kpiFromComparison(c: Comparison): ExecutiveKPI {
  return { comparison: c, trendDirection: directionFor(c.percentChange) };
}

// ─── Entry ───────────────────────────────────────────────────────────

/**
 * Build an executive summary. Returns null when there's not enough
 * snapshot history to make a meaningful comparison.
 *
 * Inputs:
 *   snapshots — chronological window (earliest first). Caller pre-
 *               filters to the desired window length.
 *   repeatCustomerData — optional {currentRepeat, currentTotal,
 *               prevRepeat, prevTotal} from the customer-intelligence
 *               aggregator. When absent, repeatCustomerPct stays at 0.
 */
export function buildExecutiveSummary(
  snapshots: DailyAggregate[],
  repeatCustomerData?: {
    currentRepeat: number;
    currentTotal: number;
    prevRepeat: number;
    prevTotal: number;
  }
): ExecutiveSummary | null {
  const split = splitForComparison(snapshots);
  if (!split) return null;

  const bookings = compareWindows(split.current, split.previous, (s) => s.totalBookings);
  const revenue = compareWindows(
    split.current,
    split.previous,
    (s) => s.extras.revenue?.netRevenueCents ?? 0
  );
  const cancellations = compareWindows(split.current, split.previous, (s) => s.cancelledBookings);
  const waitlistConv = compareWindows(split.current, split.previous, (s) => s.waitlistConversions);

  // Avg booking value: current sum of avgBookingValueCents (weighted
  // by days) vs prior. Sparse-data safe — comparison handles zero
  // baselines.
  const avgValue = compareWindows(
    split.current,
    split.previous,
    (s) => s.extras.revenue?.avgBookingValueCents ?? 0
  );

  // Repeat customer % — only computable when caller supplied data.
  const repeatPct: Comparison = repeatCustomerData
    ? {
        currentValue:
          repeatCustomerData.currentTotal > 0
            ? Math.round((repeatCustomerData.currentRepeat / repeatCustomerData.currentTotal) * 100)
            : 0,
        previousValue:
          repeatCustomerData.prevTotal > 0
            ? Math.round((repeatCustomerData.prevRepeat / repeatCustomerData.prevTotal) * 100)
            : 0,
        percentChange: 0,
        volatility: 0,
        quality: "indicative",
      }
    : { currentValue: 0, previousValue: 0, percentChange: 0, volatility: 0, quality: "insufficient" };
  if (repeatPct.previousValue > 0) {
    repeatPct.percentChange = Math.round(
      ((repeatPct.currentValue - repeatPct.previousValue) / repeatPct.previousValue) * 100
    );
  }

  // Staff efficiency = bookings per staff-assignment-row.  Higher =
  // more bookings per assignment opportunity. Reads from extras.
  const staffEfficiency = compareWindows(split.current, split.previous, (s) => {
    const total = Object.values(s.extras.staffAssignments ?? {}).reduce((a, b) => a + b, 0);
    return s.totalBookings > 0 && total > 0 ? Math.round((s.totalBookings / total) * 100) : 0;
  });

  // Confidence: average the four primary KPIs' quality scores.
  const qualityWeight = (q: Comparison["quality"]) =>
    q === "reliable" ? 1 : q === "indicative" ? 0.7 : q === "noisy" ? 0.4 : 0.2;
  const confidence = Number(
    (
      (qualityWeight(bookings.quality) +
        qualityWeight(revenue.quality) +
        qualityWeight(cancellations.quality) +
        qualityWeight(staffEfficiency.quality)) /
      4
    ).toFixed(2)
  );

  return {
    bookings: kpiFromComparison(bookings),
    revenue: kpiFromComparison(revenue),
    cancellations: kpiFromComparison(cancellations),
    waitlistConversions: kpiFromComparison(waitlistConv),
    avgBookingValue: kpiFromComparison(avgValue),
    repeatCustomerPct: kpiFromComparison(repeatPct),
    staffEfficiency: kpiFromComparison(staffEfficiency),
    confidence,
    periodDays: split.current.length,
  };
}

/** Exposed for tests. */
export const _thresholds = { FLAT_BAND_PCT } as const;
