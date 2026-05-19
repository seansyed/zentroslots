/**
 * Pure window-comparison primitives for analytics dashboards.
 *
 * Inputs are arrays of DailyAggregate snapshots in chronological order.
 * Outputs are tagged comparison objects with percent change + a
 * volatility measure + a closed quality enum.
 *
 * No DB. No clock-reading. Deterministic.
 */
import type { DailyAggregate } from "./types";

export type TrendQuality = "reliable" | "indicative" | "noisy" | "insufficient";

export type Comparison = {
  currentValue: number;
  previousValue: number;
  /** Delta as integer percent (-∞..+∞); 0 when previous=0 and current>0. */
  percentChange: number;
  /** Coefficient of variation across the merged window (0..1+). Higher
   *  = noisier; the quality flag uses this. */
  volatility: number;
  /** Closed quality enum — callers use to decide whether to surface
   *  the comparison or hide it. */
  quality: TrendQuality;
};

const NOISE_THRESHOLD = 0.5;        // CV > 0.5 → noisy
const RELIABLE_MIN_DAYS = 14;
const INDICATIVE_MIN_DAYS = 7;

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

function cv(values: number[]): number {
  const m = mean(values);
  if (m === 0) return 0;
  return stddev(values) / m;
}

/**
 * Compute a comparison between two equal-length windows.
 * `selector` extracts a numeric field from each snapshot.
 */
export function compareWindows(
  current: DailyAggregate[],
  previous: DailyAggregate[],
  selector: (s: DailyAggregate) => number
): Comparison {
  const cur = current.map(selector);
  const prev = previous.map(selector);
  const curSum = cur.reduce((a, b) => a + b, 0);
  const prevSum = prev.reduce((a, b) => a + b, 0);
  const percentChange =
    prevSum === 0
      ? curSum > 0
        ? 100
        : 0
      : Math.round(((curSum - prevSum) / prevSum) * 100);
  const merged = [...prev, ...cur];
  const volatility = Number(cv(merged).toFixed(2));

  const days = current.length;
  let quality: TrendQuality;
  if (days < INDICATIVE_MIN_DAYS) quality = "insufficient";
  else if (volatility > NOISE_THRESHOLD) quality = "noisy";
  else if (days < RELIABLE_MIN_DAYS) quality = "indicative";
  else quality = "reliable";

  return {
    currentValue: curSum,
    previousValue: prevSum,
    percentChange,
    volatility,
    quality,
  };
}

/** Split a snapshot window into THIS-PERIOD vs PRIOR-PERIOD halves
 *  of equal length. For a 30-day window: last 15 vs prior 15.
 *  Returns null if the window is too short. */
export function splitForComparison(snapshots: DailyAggregate[]): {
  current: DailyAggregate[];
  previous: DailyAggregate[];
} | null {
  if (snapshots.length < INDICATIVE_MIN_DAYS * 2) return null;
  const half = Math.floor(snapshots.length / 2);
  return {
    previous: snapshots.slice(0, half),
    current: snapshots.slice(-half),
  };
}

/** Weekday comparison: for each weekday (0..6), the sum of bookings
 *  vs the workspace-wide mean. Useful for "Fridays vs average" pills. */
export function compareWeekdays(snapshots: DailyAggregate[]): Array<{
  weekday: number;
  bookings: number;
  ratioToMean: number;
}> {
  const totals = new Array(7).fill(0);
  for (const s of snapshots) {
    const wd = s.extras.weekdayDistribution;
    if (!wd || wd.length !== 7) continue;
    for (let i = 0; i < 7; i++) totals[i] += wd[i];
  }
  const grand = totals.reduce((a, b) => a + b, 0);
  const m = grand / 7;
  return totals.map((bookings, weekday) => ({
    weekday,
    bookings,
    ratioToMean: m === 0 ? 0 : Number((bookings / m).toFixed(2)),
  }));
}

/** Exposed thresholds for tests. */
export const _thresholds = {
  NOISE_THRESHOLD,
  RELIABLE_MIN_DAYS,
  INDICATIVE_MIN_DAYS,
} as const;
