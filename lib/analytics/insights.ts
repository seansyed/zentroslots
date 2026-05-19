/**
 * Operational insight generator — pure functions over a window of
 * DailyAggregate snapshots.
 *
 * EVERY insight is derived from data. No AI, no template-without-
 * evidence. If the data doesn't clearly support a claim, the function
 * returns nothing.
 *
 * Pattern: each generator takes the snapshot array (chronological)
 * and returns a (possibly empty) list of `Insight` strings with a
 * severity / kind tag for the UI's styling.
 *
 * Closed `InsightKind` union — adding a kind requires touching the
 * UI to map it to a color. Surface area stays small.
 */
import { computeFairness } from "./utilizationMetrics";
import type { DailyAggregate } from "./types";

export type InsightKind = "positive" | "warning" | "neutral";

export type Insight = {
  kind: InsightKind;
  /** Stable code for UI styling + dedup. */
  code: string;
  message: string;
};

/** Generate insights for the given snapshot window. Insights ordering
 *  is stable (warnings first, then positive, then neutral). */
export function generateInsights(snapshots: DailyAggregate[]): Insight[] {
  if (snapshots.length === 0) return [];
  const out: Insight[] = [];

  // ── Busiest weekday ─────────────────────────────────────────────
  const busiest = busiestWeekday(snapshots);
  if (busiest) out.push(busiest);

  // ── Cancellation rate spike ────────────────────────────────────
  const cancelSpike = cancellationSpike(snapshots);
  if (cancelSpike) out.push(cancelSpike);

  // ── Waitlist recovery ───────────────────────────────────────────
  const waitlistRecovered = waitlistRecovery(snapshots);
  if (waitlistRecovered) out.push(waitlistRecovered);

  // ── Suppression trend ───────────────────────────────────────────
  const suppression = suppressionTrend(snapshots);
  if (suppression) out.push(suppression);

  // ── Staff fairness ──────────────────────────────────────────────
  const fairness = staffFairness(snapshots);
  if (fairness) out.push(fairness);

  // Stable sort: warnings call eyes first, then positives, then neutrals.
  const order: Record<InsightKind, number> = { warning: 0, positive: 1, neutral: 2 };
  out.sort((a, b) => order[a.kind] - order[b.kind]);
  return out;
}

// ─── Individual generators ─────────────────────────────────────────────

function busiestWeekday(snapshots: DailyAggregate[]): Insight | null {
  // Sum hour distributions per weekday across the window. Use the
  // PER-DAY weekdayDistribution (which is already the count per weekday
  // for that day's bookings — i.e. it'll all be on the snapshot's own
  // weekday, but summing across snapshots gives us a "Sun..Sat
  // totals" view).
  const totals = new Array(7).fill(0);
  for (const s of snapshots) {
    const wd = s.extras.weekdayDistribution;
    if (!wd || wd.length !== 7) continue;
    for (let i = 0; i < 7; i++) totals[i] += wd[i];
  }
  const grand = totals.reduce((a, b) => a + b, 0);
  if (grand < 5) return null; // not enough data to claim a busiest day

  let bestIdx = 0;
  for (let i = 1; i < 7; i++) if (totals[i] > totals[bestIdx]) bestIdx = i;
  // Only emit if the top day is at least 30% above the average.
  const avg = grand / 7;
  if (totals[bestIdx] <= avg * 1.3) return null;

  const NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
  return {
    kind: "neutral",
    code: "busiest_weekday",
    message: `${NAMES[bestIdx]} are your busiest day this period.`,
  };
}

function cancellationSpike(snapshots: DailyAggregate[]): Insight | null {
  if (snapshots.length < 14) return null;
  const half = Math.floor(snapshots.length / 2);
  const recent = snapshots.slice(-half);
  const earlier = snapshots.slice(0, snapshots.length - half);
  const recentTotal = recent.reduce((a, s) => a + s.totalBookings, 0);
  const earlierTotal = earlier.reduce((a, s) => a + s.totalBookings, 0);
  if (recentTotal < 5 || earlierTotal < 5) return null;

  const recentRate = recent.reduce((a, s) => a + s.cancelledBookings, 0) / recentTotal;
  const earlierRate = earlier.reduce((a, s) => a + s.cancelledBookings, 0) / earlierTotal;
  if (recentRate <= earlierRate * 1.3) return null;

  const deltaPct = Math.round(((recentRate - earlierRate) / Math.max(earlierRate, 0.0001)) * 100);
  return {
    kind: "warning",
    code: "cancellation_spike",
    message: `Cancellation rate is up ${deltaPct}% in the second half of this period.`,
  };
}

function waitlistRecovery(snapshots: DailyAggregate[]): Insight | null {
  const conversions = snapshots.reduce((a, s) => a + s.waitlistConversions, 0);
  if (conversions <= 0) return null;
  return {
    kind: "positive",
    code: "waitlist_recovery",
    message:
      conversions === 1
        ? `Waitlists recovered 1 booking this period.`
        : `Waitlists recovered ${conversions} bookings this period.`,
  };
}

function suppressionTrend(snapshots: DailyAggregate[]): Insight | null {
  if (snapshots.length < 14) return null;
  const half = Math.floor(snapshots.length / 2);
  const recent = snapshots.slice(-half);
  const earlier = snapshots.slice(0, snapshots.length - half);
  const recentSup = recent.reduce((a, s) => a + s.reminderEmailsSuppressed, 0);
  const earlierSup = earlier.reduce((a, s) => a + s.reminderEmailsSuppressed, 0);
  // Require non-trivial volume on both sides.
  if (recentSup < 5 || earlierSup < 5) return null;
  const delta = (recentSup - earlierSup) / earlierSup;
  if (Math.abs(delta) < 0.15) return null;
  const pct = Math.round(delta * 100);
  return {
    kind: delta > 0 ? "warning" : "positive",
    code: "suppression_trend",
    message:
      delta > 0
        ? `Reminder suppressions are up ${pct}% — customers may be opting out.`
        : `Reminder suppressions are down ${Math.abs(pct)}%.`,
  };
}

function staffFairness(snapshots: DailyAggregate[]): Insight | null {
  // Sum per-staff counts across the window.
  const totals: Record<string, number> = {};
  for (const s of snapshots) {
    const sa = s.extras.staffAssignments;
    if (!sa) continue;
    for (const [k, v] of Object.entries(sa)) {
      totals[k] = (totals[k] ?? 0) + v;
    }
  }
  const entries = Object.entries(totals);
  if (entries.length < 2) return null;
  const grand = entries.reduce((a, [, n]) => a + n, 0);
  if (grand < 10) return null; // not enough data
  const { staff, unevenness } = computeFairness(totals);
  if (unevenness < 0.35) return null;
  const top = staff[0];
  const mean = grand / entries.length;
  const pctAboveAvg = Math.round(((top.count - mean) / mean) * 100);
  return {
    kind: "warning",
    code: "staff_unevenness",
    message: `Staff utilization uneven: ${top.staffName} received ${pctAboveAvg}% more bookings than average.`,
  };
}
