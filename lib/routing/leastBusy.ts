/**
 * Least-busy mode.
 *
 * Among eligible staff, pick the one with the LOWEST assignmentsToday.
 * Tie-break: oldest lastAssignedAt (longest since they were last
 * picked). Final tie-break: staffId ascending for determinism.
 *
 * Uses staff_assignment_stats — the same source of truth round-robin
 * uses. Tenants haven't configured routing have empty stats; the
 * picker treats missing rows as "0 today".
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { staffAssignmentStats } from "@/db/schema";

export type BusyStat = {
  staffId: string;
  assignmentsToday: number;
  lastAssignedAt: Date | null;
};

export async function loadBusyStats(
  tenantId: string,
  staffIds: string[]
): Promise<BusyStat[]> {
  if (staffIds.length === 0) return [];
  const rows = await db
    .select({
      staffId: staffAssignmentStats.staffId,
      assignmentsToday: staffAssignmentStats.assignmentsToday,
      lastAssignedAt: staffAssignmentStats.lastAssignedAt,
      dayWindowStart: staffAssignmentStats.dayWindowStart,
    })
    .from(staffAssignmentStats)
    .where(
      and(
        eq(staffAssignmentStats.tenantId, tenantId),
        sql`${staffAssignmentStats.staffId} = ANY(${staffIds})`
      )
    );

  // Apply rolling-window logic INLINE here so a stale counter doesn't
  // skew the pick. If the stat row's dayWindowStart isn't today (UTC
  // calendar day), treat assignmentsToday as 0. The recorder will
  // reset it when it next writes.
  const todayKey = utcDayKey(new Date());
  return rows.map((r) => ({
    staffId: r.staffId,
    lastAssignedAt: r.lastAssignedAt,
    assignmentsToday:
      r.dayWindowStart && utcDayKey(r.dayWindowStart) === todayKey
        ? r.assignmentsToday
        : 0,
  }));
}

export function pickLeastBusyPure(args: {
  eligible: string[];
  stats: BusyStat[];
}): string | null {
  if (args.eligible.length === 0) return null;
  const byId = new Map(args.stats.map((s) => [s.staffId, s]));
  // Eligible staff with no stat row are "0 today, never assigned" — they
  // tie at the bottom of busyness and the top of fairness.
  const ranked = [...args.eligible].sort((a, b) => {
    const aStat = byId.get(a);
    const bStat = byId.get(b);
    const aToday = aStat?.assignmentsToday ?? 0;
    const bToday = bStat?.assignmentsToday ?? 0;
    if (aToday !== bToday) return aToday - bToday;
    const aLast = aStat?.lastAssignedAt?.getTime() ?? 0;
    const bLast = bStat?.lastAssignedAt?.getTime() ?? 0;
    if (aLast !== bLast) return aLast - bLast;
    return a.localeCompare(b);
  });
  return ranked[0];
}

export async function pickLeastBusy(args: {
  tenantId: string;
  eligible: string[];
}): Promise<string | null> {
  const stats = await loadBusyStats(args.tenantId, args.eligible);
  return pickLeastBusyPure({ eligible: args.eligible, stats });
}

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
