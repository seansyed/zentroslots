/**
 * Staffing intelligence — pure deterministic detectors emitting
 * human-readable strings ONLY when the data supports them.
 *
 * Categories:
 *   overload          — top staff handled >= 50% of total bookings
 *   underutilized     — staff that received < 10% of mean while
 *                       the team is otherwise busy
 *   unevenAssignment  — stddev/mean > 0.5 with ≥ 3 staff and ≥ 20 bookings
 *   highCancelWindow  — a specific weekday's cancel rate exceeds tenant
 *                       overall by > 50%
 *   bookingSurge      — recent half total bookings > prior half × 1.3
 *
 * NEVER throws. Empty windows → empty output.
 */
import { computeFairness } from "./utilizationMetrics";
import type { DailyAggregate, SnapshotExtras } from "./types";

export type StaffingInsight = {
  code:
    | "overload"
    | "underutilized"
    | "uneven_assignment"
    | "high_cancel_window"
    | "booking_surge";
  severity: "warning" | "info" | "positive";
  message: string;
};

/** Snapshot extras side-channel — counts so the dashboard can
 *  show "3 staff underutilized" without listing them. */
export type StaffingSignals = {
  overloadStaff: number;
  underutilizedStaff: number;
  unevenAssignment: boolean;
  bookingSurge: boolean;
  highCancelWeekdays: number[]; // 0..6
};

// ─── Thresholds — change here only ────────────────────────────────────

const OVERLOAD_SHARE_PCT = 50;                  // top staff handles ≥ 50%
const UNDERUTIL_RATIO = 0.1;                    // < 10% of mean
const MIN_BOOKINGS_FOR_FAIRNESS = 20;
const FAIRNESS_UNEVENNESS = 0.5;
const HIGH_CANCEL_OVER_BASELINE = 1.5;          // 50% above tenant baseline
const SURGE_MULTIPLIER = 1.3;
const MIN_VOLUME_FOR_SURGE = 10;                // per half
const MIN_WEEKDAY_VOLUME_FOR_CANCEL_INSIGHT = 8;

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ─── Entry ────────────────────────────────────────────────────────────

export function buildStaffingInsights(snapshots: DailyAggregate[]): {
  insights: StaffingInsight[];
  signals: StaffingSignals;
} {
  if (snapshots.length === 0) {
    return {
      insights: [],
      signals: { overloadStaff: 0, underutilizedStaff: 0, unevenAssignment: false, bookingSurge: false, highCancelWeekdays: [] },
    };
  }

  // Aggregate per-staff totals across the window.
  const staffTotals: Record<string, number> = {};
  for (const s of snapshots) {
    const sa = s.extras.staffAssignments ?? {};
    for (const [k, v] of Object.entries(sa)) {
      staffTotals[k] = (staffTotals[k] ?? 0) + v;
    }
  }
  const totalAssigned = Object.values(staffTotals).reduce((a, b) => a + b, 0);
  const staffCount = Object.keys(staffTotals).length;
  const mean = staffCount > 0 ? totalAssigned / staffCount : 0;

  const insights: StaffingInsight[] = [];
  let overloadCount = 0;
  let underutilCount = 0;

  // ── Overload: any single staff with ≥ 50% share ──────────────────
  if (totalAssigned >= MIN_BOOKINGS_FOR_FAIRNESS) {
    for (const [name, n] of Object.entries(staffTotals)) {
      const share = (n / totalAssigned) * 100;
      if (share >= OVERLOAD_SHARE_PCT) {
        overloadCount++;
        insights.push({
          code: "overload",
          severity: "warning",
          message: `${name} handled ${Math.round(share)}% of bookings this period — consider redistributing.`,
        });
      }
    }
  }

  // ── Underutilized: < 10% of mean ─────────────────────────────────
  if (mean > 0 && totalAssigned >= MIN_BOOKINGS_FOR_FAIRNESS) {
    for (const [name, n] of Object.entries(staffTotals)) {
      if (n < mean * UNDERUTIL_RATIO) {
        underutilCount++;
        insights.push({
          code: "underutilized",
          severity: "info",
          message: `${name} received only ${n} booking${n === 1 ? "" : "s"} (≪ team average) — staffing under-tapped.`,
        });
      }
    }
  }

  // ── Uneven assignment (overall) ──────────────────────────────────
  let unevenAssignment = false;
  if (staffCount >= 3 && totalAssigned >= MIN_BOOKINGS_FOR_FAIRNESS) {
    const { unevenness, staff } = computeFairness(staffTotals);
    if (unevenness > FAIRNESS_UNEVENNESS) {
      unevenAssignment = true;
      const top = staff[0];
      const topShare = Math.round((top.count / totalAssigned) * 100);
      insights.push({
        code: "uneven_assignment",
        severity: "warning",
        message: `Staff workload uneven (top: ${top.staffName} at ${topShare}%). Consider routing tweaks to spread bookings.`,
      });
    }
  }

  // ── Booking surge (recent half vs prior half) ────────────────────
  let bookingSurge = false;
  if (snapshots.length >= 8) {
    const half = Math.floor(snapshots.length / 2);
    const earlier = snapshots.slice(0, snapshots.length - half).reduce((a, s) => a + s.totalBookings, 0);
    const recent = snapshots.slice(-half).reduce((a, s) => a + s.totalBookings, 0);
    if (earlier >= MIN_VOLUME_FOR_SURGE && recent > earlier * SURGE_MULTIPLIER) {
      bookingSurge = true;
      const pct = Math.round(((recent - earlier) / earlier) * 100);
      insights.push({
        code: "booking_surge",
        severity: "positive",
        message: `Bookings surged ${pct}% in the second half of this period — staffing pressure rising.`,
      });
    }
  }

  // ── High cancel windows (per weekday) ────────────────────────────
  // Sum weekday-distribution bookings + per-day cancellations. The
  // assumption: a snapshot row covers ONE date; its weekday distribution
  // is effectively that day's bookings on that weekday index. So
  // summing across snapshots gives per-weekday totals.
  const weekdayBookings = new Array(7).fill(0);
  const weekdayCancels = new Array(7).fill(0);
  for (const s of snapshots) {
    const wd = s.extras.weekdayDistribution;
    if (!wd || wd.length !== 7) continue;
    for (let i = 0; i < 7; i++) {
      weekdayBookings[i] += wd[i];
      // Cancellations on a snapshot row went to dates on that snapshot's
      // weekday — distribute proportionally to wd[i] / sum(wd).
      const dayTotal = wd.reduce((a, b) => a + b, 0);
      if (dayTotal > 0) {
        weekdayCancels[i] += (wd[i] / dayTotal) * s.cancelledBookings;
      }
    }
  }
  const totalBookings = weekdayBookings.reduce((a, b) => a + b, 0);
  const totalCancels = weekdayBookings.reduce((acc, _, i) => acc + weekdayCancels[i], 0);
  const baselineRate = totalBookings > 0 ? totalCancels / totalBookings : 0;
  const highCancelWeekdays: number[] = [];
  if (baselineRate > 0 && totalBookings >= MIN_BOOKINGS_FOR_FAIRNESS) {
    for (let i = 0; i < 7; i++) {
      if (weekdayBookings[i] < MIN_WEEKDAY_VOLUME_FOR_CANCEL_INSIGHT) continue;
      const wdRate = weekdayCancels[i] / weekdayBookings[i];
      if (wdRate > baselineRate * HIGH_CANCEL_OVER_BASELINE) {
        highCancelWeekdays.push(i);
        insights.push({
          code: "high_cancel_window",
          severity: "warning",
          message: `${WEEKDAY_NAMES[i]}s have a ${Math.round(wdRate * 100)}% cancellation rate (workspace baseline ${Math.round(baselineRate * 100)}%).`,
        });
      }
    }
  }

  return {
    insights,
    signals: {
      overloadStaff: overloadCount,
      underutilizedStaff: underutilCount,
      unevenAssignment,
      bookingSurge,
      highCancelWeekdays,
    },
  };
}

/** Exposed thresholds for tests. */
export const _thresholds = {
  OVERLOAD_SHARE_PCT,
  UNDERUTIL_RATIO,
  MIN_BOOKINGS_FOR_FAIRNESS,
  FAIRNESS_UNEVENNESS,
  HIGH_CANCEL_OVER_BASELINE,
  SURGE_MULTIPLIER,
  MIN_VOLUME_FOR_SURGE,
} as const;

// Re-exported so the aggregation orchestrator can populate the
// snapshot extras side-channel.
export type { SnapshotExtras };
