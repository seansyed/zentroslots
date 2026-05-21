/**
 * Fairness analytics — derive per-staff routing share, drift, and
 * overload indicators from REAL data.
 *
 * Sources:
 *   - staff_assignment_stats — totals + rolling day/week counters
 *   - staff_assignment_rules — weighted distribution (target shares)
 *   - users — staff name/email
 *
 * No invented metrics. Drift is target-share minus actual-share, both
 * computed over the same denominator (sum of assignments in the
 * window). When no weighted rule exists, target = equal share across
 * the eligible pool.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { staffAssignmentRules, staffAssignmentStats, users } from "@/db/schema";

export type FairnessRow = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  todayCount: number;
  weekCount: number;
  totalAssignments: number;
  lastAssignedAt: string | null;
  /** Actual share of this week's assignments (0..100). Null when
   *  weeklyTotal === 0 — no engine-driven history to derive from. */
  actualSharePct: number | null;
  /** Target share from weighted rule, or equal share fallback
   *  (0..100). Null when there is no history to compare against — UI
   *  should hide the target column in that case rather than display a
   *  meaningless 100% for a single-staff tenant. */
  expectedSharePct: number | null;
  /** actual - expected. Positive = over-served. Null when fairness
   *  cannot be computed (no history). */
  driftPct: number | null;
  /** True when this staff has ≥2× the equal-share weekly load.
   *  False when there is no history. */
  overloaded: boolean;
  /** Where the target came from. */
  expectedSource: "weighted_rule" | "equal_share" | "none";
};

export type FairnessSummary = {
  rows: FairnessRow[];
  /** Highest |driftPct| across all staff. Null when no history. */
  maxAbsoluteDriftPct: number | null;
  /** Total assignments captured in the rolling weekly window. */
  weeklyTotal: number;
  /** Distinct staff that took at least one assignment this week. */
  activeAssignees: number;
  /** True when at least one engine-driven assignment exists in the
   *  rolling weekly window. When false, the UI should render a "no
   *  history yet" empty state rather than a table full of nulls. */
  hasHistory: boolean;
};

export async function computeFairness(tenantId: string): Promise<FairnessSummary> {
  // ── 1. Load all non-client staff for this tenant.
  const staffRows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
    })
    .from(users)
    .where(eq(users.tenantId, tenantId));
  const staff = staffRows.filter((s) => s.role !== "client");
  if (staff.length === 0) {
    return {
      rows: [],
      maxAbsoluteDriftPct: null,
      weeklyTotal: 0,
      activeAssignees: 0,
      hasHistory: false,
    };
  }

  // ── 2. Load assignment stats for these staff.
  const statRows = await db
    .select()
    .from(staffAssignmentStats)
    .where(eq(staffAssignmentStats.tenantId, tenantId));
  const statsById = new Map(statRows.map((r) => [r.staffId, r]));

  // ── 3. Load the tenant's weighted rule (if any) for expected shares.
  const ruleRows = await db
    .select()
    .from(staffAssignmentRules)
    .where(
      and(
        eq(staffAssignmentRules.tenantId, tenantId),
        sql`${staffAssignmentRules.serviceId} IS NULL AND ${staffAssignmentRules.locationId} IS NULL`,
      ),
    );
  const tenantDefault = ruleRows[0];
  const weightedDist =
    tenantDefault?.mode === "weighted" &&
    tenantDefault.weightedDistribution &&
    typeof tenantDefault.weightedDistribution === "object"
      ? (tenantDefault.weightedDistribution as Record<string, number>)
      : null;

  // ── 4. Compute totals.
  const todayKey = new Date().toISOString().slice(0, 10);
  const perStaff = staff.map((s) => {
    const r = statsById.get(s.id);
    const sameDay =
      r?.dayWindowStart &&
      r.dayWindowStart.toISOString().slice(0, 10) === todayKey;
    const today = sameDay ? r!.assignmentsToday : 0;
    const week = r?.assignmentsThisWeek ?? 0;
    return {
      staffId: s.id,
      staffName: s.name,
      staffEmail: s.email,
      today,
      week,
      total: r?.totalAssignments ?? 0,
      lastAssignedAt: r?.lastAssignedAt?.toISOString() ?? null,
    };
  });

  const weeklyTotal = perStaff.reduce((sum, p) => sum + p.week, 0);
  const activeAssignees = perStaff.filter((p) => p.week > 0).length;
  const hasHistory = weeklyTotal > 0;

  // ── 5. Determine expected shares.
  let totalWeight = 0;
  if (weightedDist) {
    for (const id of Object.keys(weightedDist)) {
      totalWeight += weightedDist[id] ?? 0;
    }
  }
  const equalShare = staff.length > 0 ? 100 / staff.length : 0;

  // ── 6. Build rows with drift.
  //
  // CRITICAL: when weeklyTotal === 0 there is NO engine-driven history
  // to derive drift from. A 100% / 0% / -100% trio for a single-staff
  // tenant who has never had an engine assignment is mathematically
  // meaningless and shipped as a bug in Phase 17. We now return null
  // for share/target/drift in that case and let the UI render an
  // empty-state card rather than fabricate numbers.
  const rows: FairnessRow[] = perStaff.map((p) => {
    if (!hasHistory) {
      return {
        staffId: p.staffId,
        staffName: p.staffName,
        staffEmail: p.staffEmail,
        todayCount: p.today,
        weekCount: p.week,
        totalAssignments: p.total,
        lastAssignedAt: p.lastAssignedAt,
        actualSharePct: null,
        expectedSharePct: null,
        driftPct: null,
        overloaded: false,
        expectedSource: "none",
      };
    }
    const actualSharePct = (p.week / weeklyTotal) * 100;
    let expectedSharePct = equalShare;
    let expectedSource: FairnessRow["expectedSource"] = "equal_share";
    if (weightedDist && totalWeight > 0) {
      const w = weightedDist[p.staffId] ?? 0;
      expectedSharePct = (w / totalWeight) * 100;
      expectedSource = "weighted_rule";
    }
    const driftPct = round1(actualSharePct - expectedSharePct);
    // Overload definition: this staff has ≥ 2× the equal-share weekly
    // load. Only meaningful once there's history AND more than one staff.
    const equalShareWeeklyCount =
      staff.length > 0 ? weeklyTotal / staff.length : 0;
    return {
      staffId: p.staffId,
      staffName: p.staffName,
      staffEmail: p.staffEmail,
      todayCount: p.today,
      weekCount: p.week,
      totalAssignments: p.total,
      lastAssignedAt: p.lastAssignedAt,
      actualSharePct: round1(actualSharePct),
      expectedSharePct: round1(expectedSharePct),
      driftPct,
      overloaded:
        staff.length > 1 &&
        equalShareWeeklyCount > 0 &&
        p.week >= 2 * Math.ceil(equalShareWeeklyCount),
      expectedSource,
    };
  });

  if (hasHistory) {
    // Stable sort: largest drift first so the operator sees imbalance up top.
    rows.sort((a, b) => Math.abs(b.driftPct ?? 0) - Math.abs(a.driftPct ?? 0));
  } else {
    // No history: alphabetical for stable rendering.
    rows.sort((a, b) => a.staffName.localeCompare(b.staffName));
  }

  const maxAbsoluteDriftPct = hasHistory
    ? round1(rows.reduce((m, r) => Math.max(m, Math.abs(r.driftPct ?? 0)), 0))
    : null;

  return {
    rows,
    maxAbsoluteDriftPct,
    weeklyTotal,
    activeAssignees,
    hasHistory,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
