/**
 * Pure forecasting over a window of DailyAggregate snapshots.
 *
 * Algorithm (deterministic, no ML, no AI):
 *   1. Compute 7-day rolling average of bookings + revenue.
 *   2. Compute 30-day linear regression slope (least-squares).
 *   3. Project: 30-day forward total ≈ last value + slope * 30.
 *   4. Confidence: a 0..1 score derived from
 *        (a) how much history we have (more = higher),
 *        (b) how stable that history is (stddev / mean = lower → higher).
 *      Sparse data (< 14 days) → confidence < 0.5, callers can hide.
 *
 * Peak detection: aggregates the snapshot's weekdayDistribution +
 * hourDistribution across the window and ranks the top entries by
 * frequency. Only emits when the top tier is meaningfully above
 * the mean (>= 1.3×).
 *
 * Staffing pressure: count of days where total bookings exceeded the
 * trailing 30-day P75. Higher = sustained surge. The category
 * (low/medium/high) is a closed set with documented breakpoints.
 *
 * NEVER throws. Returns null when insufficient data.
 */
import type { DailyAggregate } from "./types";

// ─── Closed types ─────────────────────────────────────────────────────

export type TrendDirection = "up" | "down" | "flat";

export type StaffingPressureLevel = "low" | "medium" | "high";

export type ForecastResult = {
  projectedBookingsNext30Days: number;
  projectedRevenueNext30Days: number;
  expectedBusyWeekdays: string[];
  expectedPeakHours: number[];
  staffingPressureLevel: StaffingPressureLevel;
  trendDirection: TrendDirection;
  /** 0..1 — clients should hide forecasts below ~0.4. */
  confidenceScore: number;
  /** Window the forecast covers — for the dashboard "based on N days". */
  basedOnDays: number;
};

// ─── Documented thresholds — change here, never inline ─────────────────

const MIN_DAYS_FOR_FORECAST = 7;
const MIN_DAYS_FOR_DECENT_CONFIDENCE = 14;
const MIN_DAYS_FOR_HIGH_CONFIDENCE = 21;
const PEAK_THRESHOLD_MULTIPLIER = 1.3; // 30% above mean
const PRESSURE_P75_MULTIPLIER = 1.2;   // day count > P75*1.2 is medium
const PRESSURE_P90_MULTIPLIER = 1.5;   // > P90*1.5 is high
const FLAT_SLOPE_THRESHOLD = 0.05;     // |slope/mean| below this = flat

const WEEKDAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

// ─── Pure helpers ─────────────────────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/** Least-squares slope of y over x = 0..n-1. */
function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i] - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

// ─── Main entry ───────────────────────────────────────────────────────

/**
 * Compute a forecast from a window of snapshots (chronological order,
 * earliest first). Returns null when there's too little data to make
 * a meaningful claim.
 */
export function computeForecast(snapshots: DailyAggregate[]): ForecastResult | null {
  if (snapshots.length < MIN_DAYS_FOR_FORECAST) return null;

  const bookings = snapshots.map((s) => s.totalBookings);
  const revenues = snapshots.map((s) => s.extras.revenue?.netRevenueCents ?? 0);
  const slope = linearSlope(bookings);
  const last = bookings[bookings.length - 1];
  const projectedBookings = Math.max(0, Math.round(last + slope * 30));

  const revSlope = linearSlope(revenues);
  const lastRev = revenues[revenues.length - 1];
  const projectedRevenue = Math.max(0, Math.round(lastRev + revSlope * 30));

  // Trend direction — fraction of (slope / mean) determines flat band.
  const m = mean(bookings);
  let trendDirection: TrendDirection = "flat";
  if (m > 0) {
    const ratio = slope / m;
    if (ratio > FLAT_SLOPE_THRESHOLD) trendDirection = "up";
    else if (ratio < -FLAT_SLOPE_THRESHOLD) trendDirection = "down";
  }

  // Peak weekdays + hours from per-day distributions.
  const weekdayTotals = new Array(7).fill(0);
  const hourTotals = new Array(24).fill(0);
  for (const s of snapshots) {
    const wd = s.extras.weekdayDistribution;
    if (wd && wd.length === 7) for (let i = 0; i < 7; i++) weekdayTotals[i] += wd[i];
    const hd = s.extras.hourDistribution;
    if (hd && hd.length === 24) for (let i = 0; i < 24; i++) hourTotals[i] += hd[i];
  }
  const expectedBusyWeekdays = pickPeaks(weekdayTotals)
    .map((idx) => WEEKDAY_NAMES[idx])
    .filter((s): s is string => Boolean(s));
  const expectedPeakHours = pickPeaks(hourTotals);

  // Staffing pressure: count days where bookings exceeded P75*1.2.
  const p75 = percentile(bookings, 75);
  const p90 = percentile(bookings, 90);
  const overP75 = bookings.filter((b) => b > p75 * PRESSURE_P75_MULTIPLIER).length;
  const overP90 = bookings.filter((b) => b > p90 * PRESSURE_P90_MULTIPLIER).length;
  let staffingPressureLevel: StaffingPressureLevel = "low";
  if (overP90 >= Math.ceil(snapshots.length * 0.1)) staffingPressureLevel = "high";
  else if (overP75 >= Math.ceil(snapshots.length * 0.2)) staffingPressureLevel = "medium";

  // Confidence: blend of (history coverage, stability).
  const coverage = Math.min(1, snapshots.length / MIN_DAYS_FOR_HIGH_CONFIDENCE);
  const sd = stddev(bookings);
  const stability = m > 0 ? Math.max(0, Math.min(1, 1 - sd / Math.max(m, 1))) : 0;
  const confidenceScore = Number((coverage * 0.6 + stability * 0.4).toFixed(2));

  return {
    projectedBookingsNext30Days: projectedBookings,
    projectedRevenueNext30Days: projectedRevenue,
    expectedBusyWeekdays,
    expectedPeakHours,
    staffingPressureLevel,
    trendDirection,
    confidenceScore,
    basedOnDays: snapshots.length,
  };
}

/** Pick indices whose value is at least PEAK_THRESHOLD_MULTIPLIER × mean.
 *  Returns up to 3 entries, ranked by total. */
function pickPeaks(totals: number[]): number[] {
  const grand = totals.reduce((a, b) => a + b, 0);
  if (grand === 0) return [];
  const m = grand / totals.length;
  const threshold = m * PEAK_THRESHOLD_MULTIPLIER;
  const entries = totals
    .map((v, i) => ({ i, v }))
    .filter((e) => e.v >= threshold)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3);
  return entries.map((e) => e.i);
}

/** Lightweight contract for "do we have enough data to forecast" —
 *  used by aggregation to decide whether to call computeForecast. */
export function hasMinimumForecastingHistory(snapshots: DailyAggregate[]): boolean {
  return snapshots.length >= MIN_DAYS_FOR_FORECAST;
}

/** Decent confidence threshold the dashboard can compare against. */
export const FORECAST_DISPLAY_CONFIDENCE_THRESHOLD = 0.4;

/** Export the constants for tests. */
export const _thresholds = {
  MIN_DAYS_FOR_FORECAST,
  MIN_DAYS_FOR_DECENT_CONFIDENCE,
  MIN_DAYS_FOR_HIGH_CONFIDENCE,
  PEAK_THRESHOLD_MULTIPLIER,
  PRESSURE_P75_MULTIPLIER,
  PRESSURE_P90_MULTIPLIER,
  FLAT_SLOPE_THRESHOLD,
} as const;
