/**
 * Weighted distribution mode.
 *
 * Configuration: an object mapping staffId → percent (0..100). The
 * percents represent the LONG-TERM share of bookings each staff
 * member should receive. They don't need to sum to exactly 100 — the
 * picker normalizes.
 *
 * Naive weighted-random gives weight-proportional picks on AVERAGE
 * but exhibits streak bias on a single run (a 50% staff member can
 * legitimately get picked 6 times in a row). Customer-facing
 * scheduling treats that as broken fairness.
 *
 * Fix: deficit-based correction. We compare each eligible staff's
 * ACTUAL share so far (totalAssignments) against their TARGET share
 * (weight × totalTenantAssignments). The pick goes to the eligible
 * staff with the largest deficit (target − actual). Ties broken by
 * staffId for determinism.
 *
 * When all eligible staff are exactly on-target (no deficit), we
 * fall through to a weighted random pick using the provided RNG.
 * The seedable RNG argument exists so tests can pin outcomes.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { staffAssignmentStats } from "@/db/schema";

export type WeightStat = {
  staffId: string;
  totalAssignments: number;
};

export async function loadTotals(
  tenantId: string,
  staffIds: string[]
): Promise<WeightStat[]> {
  if (staffIds.length === 0) return [];
  const rows = await db
    .select({
      staffId: staffAssignmentStats.staffId,
      totalAssignments: staffAssignmentStats.totalAssignments,
    })
    .from(staffAssignmentStats)
    .where(
      and(
        eq(staffAssignmentStats.tenantId, tenantId),
        sql`${staffAssignmentStats.staffId} = ANY(${staffIds})`
      )
    );
  return rows;
}

export function pickWeightedPure(args: {
  /** {staffId: percent}, percents 0..100. Sum doesn't have to be 100. */
  weights: Record<string, number>;
  /** Eligible staff for this request — intersection of routing pool
   *  and availability filter. */
  eligible: string[];
  /** Loaded totals (any missing entry treated as 0). */
  stats: WeightStat[];
  /** RNG in [0, 1). Defaults to Math.random; tests pass a seeded one. */
  rng?: () => number;
}): string | null {
  if (args.eligible.length === 0) return null;
  const rng = args.rng ?? Math.random;

  // Step 1: restrict weights to eligible staff with positive weight.
  const eligibleWeights: Record<string, number> = {};
  let totalWeight = 0;
  for (const id of args.eligible) {
    const w = args.weights[id];
    if (typeof w === "number" && w > 0) {
      eligibleWeights[id] = w;
      totalWeight += w;
    }
  }
  // No eligible staff has a configured positive weight → caller may
  // want to fall back to round-robin. We return null so the
  // orchestrator can decide.
  if (totalWeight === 0) return null;

  // Step 2: compute deficit. ActualShare = totalAssignments[i] / sumTotals.
  // TargetShare = weight[i] / totalWeight.
  const sumTotals = args.eligible.reduce((acc, id) => {
    const s = args.stats.find((x) => x.staffId === id);
    return acc + (s?.totalAssignments ?? 0);
  }, 0);

  // For the first ever assignment (sumTotals === 0), there's no
  // history to correct against — fall straight through to weighted
  // random.
  if (sumTotals > 0) {
    let bestDeficit = -Infinity;
    let bestPick: string | null = null;
    const ids = Object.keys(eligibleWeights).sort();
    for (const id of ids) {
      const total = args.stats.find((s) => s.staffId === id)?.totalAssignments ?? 0;
      const actualShare = total / sumTotals;
      const targetShare = eligibleWeights[id] / totalWeight;
      const deficit = targetShare - actualShare;
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestPick = id;
      }
    }
    // Only honor a positive-deficit pick — if everyone is on or above
    // target (deficit <= 0), fall through to weighted random so we
    // don't keep starving the leader.
    if (bestDeficit > 0 && bestPick) return bestPick;
  }

  // Step 3: weighted random over eligible.
  let r = rng() * totalWeight;
  // Deterministic order — same as the deficit loop — so a seeded RNG
  // produces stable test results.
  const ids = Object.keys(eligibleWeights).sort();
  for (const id of ids) {
    r -= eligibleWeights[id];
    if (r <= 0) return id;
  }
  return ids[ids.length - 1];
}

export async function pickWeighted(args: {
  tenantId: string;
  eligible: string[];
  weights: Record<string, number>;
}): Promise<string | null> {
  const stats = await loadTotals(args.tenantId, args.eligible);
  return pickWeightedPure({ weights: args.weights, eligible: args.eligible, stats });
}
