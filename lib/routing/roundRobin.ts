/**
 * Round-robin mode.
 *
 * Among eligible staff, pick the one whose lastAssignedAt is OLDEST
 * (or null — never been assigned). Staff with no stats row sort first
 * (treated as "never picked").
 *
 * Stable tie-break: by user id ascending. This makes test outcomes
 * deterministic.
 */
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db/client";
import { staffAssignmentStats } from "@/db/schema";

export type StatRow = {
  staffId: string;
  lastAssignedAt: Date | null;
  totalAssignments: number;
};

export async function loadStats(tenantId: string, staffIds: string[]): Promise<StatRow[]> {
  if (staffIds.length === 0) return [];
  const rows = await db
    .select({
      staffId: staffAssignmentStats.staffId,
      lastAssignedAt: staffAssignmentStats.lastAssignedAt,
      totalAssignments: staffAssignmentStats.totalAssignments,
    })
    .from(staffAssignmentStats)
    .where(
      and(
        eq(staffAssignmentStats.tenantId, tenantId),
        inArray(staffAssignmentStats.staffId, staffIds),
      ),
    );
  return rows;
}

/**
 * Pure selection — given an eligible pool and the loaded stats, pick.
 * Exported separately so unit tests can drive it without a DB.
 */
export function pickRoundRobinPure(args: {
  eligible: string[];
  stats: StatRow[];
}): string | null {
  if (args.eligible.length === 0) return null;
  const byId = new Map(args.stats.map((s) => [s.staffId, s]));
  // Sort: never-assigned (no stat row or null lastAssignedAt) first,
  // then by lastAssignedAt ascending, then by staffId ascending for
  // determinism.
  const sorted = [...args.eligible].sort((a, b) => {
    const aStat = byId.get(a);
    const bStat = byId.get(b);
    const aNeverAssigned = !aStat || aStat.lastAssignedAt === null;
    const bNeverAssigned = !bStat || bStat.lastAssignedAt === null;
    if (aNeverAssigned && !bNeverAssigned) return -1;
    if (!aNeverAssigned && bNeverAssigned) return 1;
    if (aNeverAssigned && bNeverAssigned) return a.localeCompare(b);
    // Both have a lastAssignedAt; pick the older one.
    const diff = aStat!.lastAssignedAt!.getTime() - bStat!.lastAssignedAt!.getTime();
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
  return sorted[0];
}

export async function pickRoundRobin(args: {
  tenantId: string;
  eligible: string[];
}): Promise<string | null> {
  const stats = await loadStats(args.tenantId, args.eligible);
  return pickRoundRobinPure({ eligible: args.eligible, stats });
}
