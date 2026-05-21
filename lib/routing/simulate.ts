/**
 * Routing simulation — reasoning-rich dry run of the real engine.
 *
 * Calls the same primitives the production `assignStaff` orchestrator
 * uses, but instead of returning just the winner it records the WHY
 * for every candidate at every elimination step. No fake decisions:
 * eligibility is computed against live availability + external Google
 * busy + existing confirmed bookings. The picker (round_robin /
 * least_busy / priority / weighted) is the same one the booking POST
 * would call at insert time.
 *
 * Stateless. Never writes. Never affects assignment stats.
 *
 * Used by:
 *   - POST /api/tenant/routing/simulate  (admin-only what-if console)
 *
 * Architecture note: we intentionally re-derive the rule + the eligible
 * pool step-by-step here rather than reusing `assignStaff` directly,
 * because the orchestrator deliberately returns a thin result. The
 * orchestrator is the right shape for the booking hot path; this is
 * the right shape for the operator console.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  serviceStaff,
  staffAssignmentRules,
  users,
} from "@/db/schema";
import { getExternalBusyForUser } from "@/lib/calendar/sync";

import { isStaffWorkingForRouting } from "./eligibility";
import { loadBusyStats, pickLeastBusyPure } from "./leastBusy";
import { pickPriority } from "./priority";
import { pickRoundRobin } from "./roundRobin";
import { type RoutingMode, type RoutingRule } from "./types";
import { pickWeighted } from "./weighted";

export type SimulationCandidate = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  /**
   * eligible — passed every filter; was in the picker pool
   * skipped   — eliminated by an eligibility check (see `reason`)
   * picked    — the winner returned by the picker
   */
  status: "eligible" | "skipped" | "picked";
  /** Human-readable elimination reason or "available". */
  reason: string;
  /** Which step eliminated this candidate. */
  step:
    | "in_pool"
    | "service_pool"
    | "rule_pool"
    | "working_hours"
    | "internal_conflict"
    | "external_busy"
    | "picker";
};

export type SimulationResult = {
  /** The rule that drove the decision (most specific match). */
  rule: {
    scope: "service" | "tenant_default" | "none";
    mode: RoutingMode | "no_rule";
    enabled: boolean;
    serviceId: string | null;
  };
  /** Final outcome — mirrors the production orchestrator's contract. */
  decision:
    | { ok: true; staffId: string; mode: RoutingMode; reason: string }
    | { ok: false; mode: RoutingMode | "no_rule"; reason: string };
  /** Per-candidate reasoning trail in stable order (alpha by name). */
  candidates: SimulationCandidate[];
  /** Counts for the operator console hero. */
  counts: {
    inPool: number;
    eligible: number;
    skippedByWorkingHours: number;
    skippedByInternalConflict: number;
    skippedByExternalBusy: number;
    skippedByRulePool: number;
  };
};

export type SimulateInput = {
  tenantId: string;
  serviceId: string;
  /** Window the customer would have asked for. */
  startAt: Date;
  endAt: Date;
};

export async function simulateAssignment(
  input: SimulateInput,
): Promise<SimulationResult> {
  // ── (1) Resolve the applicable rule — same specificity ordering as
  // the live orchestrator. service-specific > tenant default.
  const ruleRow = await loadApplicableRuleRow(input.tenantId, input.serviceId);
  const rule: RoutingRule | null = ruleRow
    ? {
        id: ruleRow.id,
        serviceId: ruleRow.serviceId,
        locationId: ruleRow.locationId,
        mode: ruleRow.mode as RoutingMode,
        enabled: ruleRow.enabled,
        priorityOrder: Array.isArray(ruleRow.priorityOrder)
          ? (ruleRow.priorityOrder as string[])
          : [],
        weightedDistribution:
          ruleRow.weightedDistribution && typeof ruleRow.weightedDistribution === "object"
            ? (ruleRow.weightedDistribution as Record<string, number>)
            : {},
      }
    : null;

  const ruleSummary = {
    scope: (ruleRow
      ? ruleRow.serviceId
        ? "service"
        : "tenant_default"
      : "none") as "service" | "tenant_default" | "none",
    mode: (rule?.mode ?? "no_rule") as RoutingMode | "no_rule",
    enabled: rule?.enabled ?? false,
    serviceId: ruleRow?.serviceId ?? null,
  };

  // ── (2) Load the service's full staff pool with names.
  const poolRows = await db
    .select({
      userId: serviceStaff.userId,
      name: users.name,
      email: users.email,
      timezone: users.timezone,
    })
    .from(serviceStaff)
    .innerJoin(users, eq(serviceStaff.userId, users.id))
    .where(
      and(
        eq(serviceStaff.tenantId, input.tenantId),
        eq(serviceStaff.serviceId, input.serviceId),
      ),
    );

  // Internal candidate shape carries timezone for the per-user working-
  // hours check. We strip it from the response shape at the end.
  type InternalCandidate = SimulationCandidate & { tz: string };
  const candidates: InternalCandidate[] = poolRows
    .map((p) => ({
      staffId: p.userId,
      staffName: p.name,
      staffEmail: p.email,
      tz: p.timezone ?? "UTC",
      status: "eligible" as const,
      reason: "in service pool",
      step: "in_pool" as SimulationCandidate["step"],
    }))
    .sort((a, b) => a.staffName.localeCompare(b.staffName));

  // No staff at all in the service pool — short-circuit.
  if (candidates.length === 0) {
    return {
      rule: ruleSummary,
      decision: { ok: false, mode: ruleSummary.mode, reason: "service_pool_empty" },
      candidates: [],
      counts: {
        inPool: 0,
        eligible: 0,
        skippedByWorkingHours: 0,
        skippedByInternalConflict: 0,
        skippedByExternalBusy: 0,
        skippedByRulePool: 0,
      },
    };
  }

  // ── (3) Rule pool restriction (priority/weighted only).
  let restrictTo: Set<string> | null = null;
  if (rule && rule.mode === "priority") {
    restrictTo = new Set(rule.priorityOrder);
  } else if (rule && rule.mode === "weighted") {
    restrictTo = new Set(Object.keys(rule.weightedDistribution));
  }

  if (restrictTo) {
    for (const c of candidates) {
      if (c.status === "eligible" && !restrictTo.has(c.staffId)) {
        c.status = "skipped";
        c.step = "rule_pool";
        c.reason = `not in ${rule!.mode} pool`;
      }
    }
  }

  // ── (4) Working-hours check — per-user because each staff has their
  // own timezone. We reuse the same helper the production engine uses.
  await Promise.all(
    candidates.map(async (c) => {
      if (c.status !== "eligible") return;
      const working = await isStaffWorkingForRouting(
        c.staffId,
        input.startAt,
        input.endAt,
        c.tz,
      );
      if (!working) {
        c.status = "skipped";
        c.step = "working_hours";
        c.reason = "outside working hours or on PTO";
      }
    }),
  );

  // ── (5) Internal booking conflicts — one query for all still-
  // eligible candidates.
  const stillEligibleIds = candidates
    .filter((c) => c.status === "eligible")
    .map((c) => c.staffId);
  if (stillEligibleIds.length > 0) {
    const conflictRows = await db
      .select({ staffUserId: bookings.staffUserId })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, input.tenantId),
          eq(bookings.status, "confirmed"),
          sql`${bookings.staffUserId} = ANY(${stillEligibleIds})`,
          gte(bookings.endAt, input.startAt),
          lt(bookings.startAt, input.endAt),
        ),
      );
    const busyIds = new Set(conflictRows.map((r) => r.staffUserId));
    for (const c of candidates) {
      if (c.status === "eligible" && busyIds.has(c.staffId)) {
        c.status = "skipped";
        c.step = "internal_conflict";
        c.reason = "already booked in this window";
      }
    }
  }

  // ── (6) External Google Calendar busy — per-staff async.
  await Promise.all(
    candidates.map(async (c) => {
      if (c.status !== "eligible") return;
      const busy = await getExternalBusyForUser(c.staffId, input.startAt, input.endAt);
      const collides = busy.some(
        (b) => b.start < input.endAt && input.startAt < b.end,
      );
      if (collides) {
        c.status = "skipped";
        c.step = "external_busy";
        c.reason = "Google Calendar busy event";
      }
    }),
  );

  const eligible = candidates.filter((c) => c.status === "eligible");

  // ── (7) Picker — only runs when we actually have a rule + eligible.
  let decision: SimulationResult["decision"];

  if (!rule || !rule.enabled || rule.mode === "manual") {
    decision = {
      ok: false,
      mode: rule?.mode ?? "no_rule",
      reason: rule
        ? rule.enabled
          ? "manual_mode_fallback_to_legacy"
          : "rule_disabled"
        : "no_rule",
    };
  } else if (eligible.length === 0) {
    decision = { ok: false, mode: rule.mode, reason: "no_available_staff" };
  } else {
    let pick: string | null = null;
    let reason = "";
    const eligibleIds = eligible.map((e) => e.staffId);
    switch (rule.mode) {
      case "round_robin":
        pick = await pickRoundRobin({ tenantId: input.tenantId, eligible: eligibleIds });
        reason = `round_robin among ${eligible.length} eligible`;
        break;
      case "least_busy": {
        const stats = await loadBusyStats(input.tenantId, eligibleIds);
        pick = pickLeastBusyPure({ eligible: eligibleIds, stats });
        reason = `least_busy among ${eligible.length} eligible`;
        break;
      }
      case "priority":
        pick = pickPriority({ priorityOrder: rule.priorityOrder, eligible: eligibleIds });
        reason = pick
          ? `priority position ${rule.priorityOrder.indexOf(pick) + 1} of ${rule.priorityOrder.length}`
          : "no priority match";
        break;
      case "weighted":
        pick = await pickWeighted({
          tenantId: input.tenantId,
          eligible: eligibleIds,
          weights: rule.weightedDistribution,
        });
        reason = "weighted_deficit_corrected";
        break;
    }

    if (pick) {
      decision = { ok: true, staffId: pick, mode: rule.mode, reason };
      const winner = candidates.find((c) => c.staffId === pick);
      if (winner) {
        winner.status = "picked";
        winner.step = "picker";
        winner.reason = reason;
      }
    } else {
      decision = { ok: false, mode: rule.mode, reason: "no_pick_in_pool" };
    }
  }

  // ── Counts for hero chips.
  const counts = {
    inPool: candidates.length,
    eligible: candidates.filter((c) => c.status === "eligible" || c.status === "picked").length,
    skippedByWorkingHours: candidates.filter((c) => c.step === "working_hours").length,
    skippedByInternalConflict: candidates.filter((c) => c.step === "internal_conflict").length,
    skippedByExternalBusy: candidates.filter((c) => c.step === "external_busy").length,
    skippedByRulePool: candidates.filter((c) => c.step === "rule_pool").length,
  };

  return {
    rule: ruleSummary,
    decision,
    candidates: candidates.map(({ staffId, staffName, staffEmail, status, reason, step }) => ({
      staffId,
      staffName,
      staffEmail,
      status,
      reason,
      step,
    })),
    counts,
  };
}

async function loadApplicableRuleRow(tenantId: string, serviceId: string) {
  const candidates = await db
    .select()
    .from(staffAssignmentRules)
    .where(
      and(
        eq(staffAssignmentRules.tenantId, tenantId),
        sql`(
          (${staffAssignmentRules.serviceId} = ${serviceId} AND ${staffAssignmentRules.locationId} IS NULL)
          OR (${staffAssignmentRules.serviceId} IS NULL AND ${staffAssignmentRules.locationId} IS NULL)
        )`,
      ),
    );
  if (candidates.length === 0) return null;
  const rank = (r: (typeof candidates)[number]): number => {
    if (r.serviceId) return 0;
    if (r.locationId) return 1;
    return 2;
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0];
}
