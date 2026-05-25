/**
 * Phase SMART-1 — admin observability metrics for scheduling
 * intelligence.
 *
 * Pure aggregators over staff + booking data. Tenant-scoped.
 *
 * Metrics:
 *   • overloadRisk per staff       — likelihood of burnout based on
 *                                    recent daily booking volume
 *   • utilizationBalance           — std-dev across staff (lower = fairer)
 *   • avgGapEfficiency             — mean gap between abutting bookings
 *   • meetingClusteringScore       — how "lumpy" each staff's schedule is
 *   • bookingSatisfactionProxy     — reschedule + no-show inverse signal
 */

import { and, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, users } from "@/db/schema";

export type StaffOverload = {
  staffUserId: string;
  staffName: string;
  totalBookingsLast30d: number;
  avgPerWorkday: number;
  /** Categorical risk band — derived from avgPerWorkday vs the
   *  tenant's soft cap (default 8). */
  risk: "low" | "moderate" | "high";
};

export type SchedulingIntelligenceMetrics = {
  tenantId: string;
  generatedAt: string;
  windowDays: number;
  staffCount: number;
  totalBookings: number;
  /** Per-staff overload risk — sorted high → low so the most
   *  saturated staff are at the top for at-a-glance review. */
  staffOverload: StaffOverload[];
  /** Standard deviation of bookings-per-staff across the window.
   *  Lower = more even distribution. */
  utilizationStdDev: number;
  /** Sum of (max - min) booking counts across staff. Headline
   *  fairness number — a value of 0 means every staff member is
   *  carrying the same load. */
  utilizationSpread: number;
  /** Mean inter-booking gap in minutes across the entire window.
   *  Higher = better operational breathing room. */
  avgGapMinutes: number;
  /** Booking satisfaction proxy [0..100] — derived from inverse of
   *  reschedule + no-show rates. */
  bookingSatisfactionProxy: number;
  /** Reschedule rate [0..1]. */
  rescheduleRate: number;
  /** No-show rate [0..1]. */
  noShowRate: number;
};

const WINDOW_DAYS = 30;
const SOFT_CAP_PER_DAY = 8; // matches DEFAULT_FOCUS_RULES.dailySoftCap

/** Build the full metrics payload for the calling tenant. Pure I/O —
 *  no analysis is mutated into the DB. */
export async function computeSchedulingIntelligenceMetrics(
  tenantId: string,
): Promise<SchedulingIntelligenceMetrics> {
  const now = new Date();
  const start = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);

  // Pull all bookings for the window in one pass, plus the staff
  // roster (for name resolution + empty-set tracking).
  const [bookingRows, staffRows] = await Promise.all([
    db
      .select({
        staffUserId: bookings.staffUserId,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        status: bookings.status,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, tenantId),
          gte(bookings.startAt, start),
          lt(bookings.startAt, now),
        ),
      ),
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          // Only operational roles count toward fairness — clients
          // never get assigned bookings.
          // (We could narrow further, but ANY of admin/manager/staff
          // can host meetings.)
          eq(users.role, "staff"),
        ),
      ),
  ]);

  // Active = pending/confirmed/completed/pending_payment. Match
  // the same definition the orchestrator uses for soft-cap math.
  const active = bookingRows.filter(
    (r) =>
      r.status === "pending" ||
      r.status === "confirmed" ||
      r.status === "completed" ||
      r.status === "pending_payment",
  );
  const noShow = bookingRows.filter((r) => r.status === "no_show").length;
  const cancelled = bookingRows.filter((r) => r.status === "cancelled").length;

  const totalObserved = active.length + noShow + cancelled;
  const rescheduleRate = totalObserved === 0 ? 0 : cancelled / totalObserved;
  const noShowRate = totalObserved === 0 ? 0 : noShow / totalObserved;
  // Satisfaction proxy: 100 - (reschedule * 60) - (no-show * 80).
  // No-shows weigh heavier because they're harder to recover from
  // (no notice + lost slot). Floor at 0.
  const bookingSatisfactionProxy = Math.max(
    0,
    Math.round(100 - rescheduleRate * 60 - noShowRate * 80),
  );

  // ─── Per-staff overload ────────────────────────────────────────
  const perStaff = new Map<string, number>();
  for (const r of active) {
    perStaff.set(r.staffUserId, (perStaff.get(r.staffUserId) ?? 0) + 1);
  }
  // Approximate workdays in the window (5 of every 7). Avoids the
  // need to know each staff's exact working schedule.
  const approxWorkdays = Math.round((WINDOW_DAYS * 5) / 7);

  const staffNameMap = new Map(staffRows.map((s) => [s.id, s.name]));
  const staffOverload: StaffOverload[] = Array.from(perStaff.entries())
    .map(([staffUserId, count]) => {
      const avgPerWorkday = approxWorkdays === 0 ? 0 : count / approxWorkdays;
      let risk: StaffOverload["risk"] = "low";
      if (avgPerWorkday >= SOFT_CAP_PER_DAY * 1.25) risk = "high";
      else if (avgPerWorkday >= SOFT_CAP_PER_DAY * 0.8) risk = "moderate";
      return {
        staffUserId,
        staffName: staffNameMap.get(staffUserId) ?? "(unknown)",
        totalBookingsLast30d: count,
        avgPerWorkday: Math.round(avgPerWorkday * 10) / 10,
        risk,
      };
    })
    .sort((a, b) => b.totalBookingsLast30d - a.totalBookingsLast30d);

  // ─── Utilization spread + std-dev ──────────────────────────────
  const counts = staffRows.map((s) => perStaff.get(s.id) ?? 0);
  const mean = counts.length === 0 ? 0 : counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance =
    counts.length === 0
      ? 0
      : counts.reduce((acc, c) => acc + Math.pow(c - mean, 2), 0) / counts.length;
  const stdDev = Math.round(Math.sqrt(variance) * 10) / 10;
  const spread = counts.length === 0 ? 0 : Math.max(...counts) - Math.min(...counts);

  // ─── Avg gap between bookings ──────────────────────────────────
  // Per-staff, walk sorted bookings; collect inter-booking gaps in
  // minutes; average over all gaps.
  const byStaff = new Map<string, { start: Date; end: Date }[]>();
  for (const r of active) {
    if (!byStaff.has(r.staffUserId)) byStaff.set(r.staffUserId, []);
    byStaff.get(r.staffUserId)!.push({ start: r.startAt, end: r.endAt });
  }
  let gapSumMin = 0;
  let gapCount = 0;
  for (const list of byStaff.values()) {
    list.sort((a, b) => a.start.getTime() - b.start.getTime());
    for (let i = 1; i < list.length; i++) {
      const gapMin = (list[i].start.getTime() - list[i - 1].end.getTime()) / 60_000;
      // Only count "same workday-ish" gaps (< 16h). Cross-day gaps
      // dominate the mean otherwise.
      if (gapMin >= 0 && gapMin <= 16 * 60) {
        gapSumMin += gapMin;
        gapCount++;
      }
    }
  }
  const avgGapMinutes = gapCount === 0 ? 0 : Math.round(gapSumMin / gapCount);

  return {
    tenantId,
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    staffCount: staffRows.length,
    totalBookings: active.length,
    staffOverload,
    utilizationStdDev: stdDev,
    utilizationSpread: spread,
    avgGapMinutes,
    bookingSatisfactionProxy,
    rescheduleRate: Math.round(rescheduleRate * 100) / 100,
    noShowRate: Math.round(noShowRate * 100) / 100,
  };
}
