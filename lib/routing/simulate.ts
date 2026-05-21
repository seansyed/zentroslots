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
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  serviceStaff,
  staffAssignmentRules,
  users,
} from "@/db/schema";
import { getExternalBusyForUser } from "@/lib/calendar/sync";

import { checkStaffWorkingForRouting } from "./eligibility";
import { loadBusyStats, pickLeastBusyPure } from "./leastBusy";
import { pickPriority } from "./priority";
import { pickRoundRobin } from "./roundRobin";
import { type RoutingMode, type RoutingRule } from "./types";
import { pickWeighted } from "./weighted";

/**
 * Phase 15G — explicit reason taxonomy. Every code below maps to an
 * observable backend state. We intentionally do NOT include taxonomy
 * entries for engine behaviors that don't exist yet (max daily
 * bookings, capacity caps, hidden-from-booking) — those would be
 * fake categories under the "no fake analytics" rule.
 */
export type EligibilityReasonCode =
  | "in_service_pool"        // passed every filter so far
  | "not_in_rule_pool"        // priority/weighted mode pool restriction
  | "pto_override"            // availability_overrides.unavailable = true today
  | "outside_working_hours"   // weekly schedule exists but doesn't cover the window
  | "no_schedule"             // no weekly availability row + no override hours
  | "internal_conflict"       // overlapping confirmed booking on the staff
  | "calendar_conflict"       // overlapping busy event from connected calendar
  | "picked"                  // the winner returned by the picker
  | "not_picked";             // eligible but the picker chose someone else

export type SimulationCandidate = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  /**
   * eligible — passed every filter; was in the picker pool
   * skipped   — eliminated by an eligibility check (see `reasonCode`)
   * picked    — the winner returned by the picker
   */
  status: "eligible" | "skipped" | "picked";
  /** Machine-readable elimination code. UI maps to label + tooltip. */
  reasonCode: EligibilityReasonCode;
  /** Human-readable elimination reason. Safe to render directly. */
  reason: string;
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
    skippedByPto: number;
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
      reasonCode: "in_service_pool" as EligibilityReasonCode,
      reason: "in service pool",
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
        skippedByPto: 0,
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
        c.reasonCode = "not_in_rule_pool";
        c.reason = `not in ${rule!.mode} pool`;
      }
    }
  }

  // ── (4) Working-hours check — per-user because each staff has their
  // own timezone. We use the richer checkStaffWorkingForRouting helper
  // so PTO / outside-hours / no-schedule are distinguishable in the UI.
  await Promise.all(
    candidates.map(async (c) => {
      if (c.status !== "eligible") return;
      const result = await checkStaffWorkingForRouting(
        c.staffId,
        input.startAt,
        input.endAt,
        c.tz,
      );
      if (!result.working) {
        c.status = "skipped";
        switch (result.reason) {
          case "pto_override":
            c.reasonCode = "pto_override";
            c.reason = "PTO override active for this date";
            break;
          case "outside_working_hours":
            c.reasonCode = "outside_working_hours";
            c.reason = "outside scheduled working hours";
            break;
          case "no_schedule":
            c.reasonCode = "no_schedule";
            c.reason = "no weekly schedule configured for this day";
            break;
        }
      }
    }),
  );

  // ── (5) Internal booking conflicts — one query for all still-
  // eligible candidates. Use inArray() rather than `= ANY(${arr})`
  // because the postgres-js driver serializes single-element arrays
  // as bare strings in the ANY position, which PG then tries to
  // parse as an array literal and fails with "malformed array
  // literal". inArray() emits IN (...) which is always safe.
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
          inArray(bookings.staffUserId, stillEligibleIds),
          gte(bookings.endAt, input.startAt),
          lt(bookings.startAt, input.endAt),
        ),
      );
    const busyIds = new Set(conflictRows.map((r) => r.staffUserId));
    for (const c of candidates) {
      if (c.status === "eligible" && busyIds.has(c.staffId)) {
        c.status = "skipped";
        c.reasonCode = "internal_conflict";
        c.reason = "already has a confirmed booking that overlaps this window";
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
        c.reasonCode = "calendar_conflict";
        c.reason = "connected calendar has a busy event in this window";
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
      // Mark the winner + flip every other eligible candidate to a
      // distinct "not_picked" code so the UI can render "considered
      // but not chosen" alongside the actual skips.
      for (const c of candidates) {
        if (c.staffId === pick) {
          c.status = "picked";
          c.reasonCode = "picked";
          c.reason = reason;
        } else if (c.status === "eligible") {
          c.reasonCode = "not_picked";
          c.reason = `eligible but ${rule.mode} chose someone else`;
        }
      }
    } else {
      decision = { ok: false, mode: rule.mode, reason: "no_pick_in_pool" };
    }
  }

  // ── Counts for hero chips. Sourced from the canonical reasonCode
  // so the UI doesn't need to know the internal step naming.
  const counts = {
    inPool: candidates.length,
    eligible: candidates.filter(
      (c) => c.status === "eligible" || c.status === "picked",
    ).length,
    skippedByPto: candidates.filter((c) => c.reasonCode === "pto_override").length,
    skippedByWorkingHours: candidates.filter(
      (c) => c.reasonCode === "outside_working_hours" || c.reasonCode === "no_schedule",
    ).length,
    skippedByInternalConflict: candidates.filter(
      (c) => c.reasonCode === "internal_conflict",
    ).length,
    skippedByExternalBusy: candidates.filter(
      (c) => c.reasonCode === "calendar_conflict",
    ).length,
    skippedByRulePool: candidates.filter(
      (c) => c.reasonCode === "not_in_rule_pool",
    ).length,
  };

  return {
    rule: ruleSummary,
    decision,
    candidates: candidates.map(
      ({ staffId, staffName, staffEmail, status, reason, reasonCode }) => ({
        staffId,
        staffName,
        staffEmail,
        status,
        reason,
        reasonCode,
      }),
    ),
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
