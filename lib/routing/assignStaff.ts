/**
 * Routing orchestrator — single entry point used by /api/bookings POST.
 *
 *   assignStaff(input)
 *     1. Read the rule: service-specific → location-specific → tenant
 *        default. If no rule, return {ok:false, mode:"no_rule"} so the
 *        caller can fall back to the legacy round-robin path (rule #13
 *        — byte-identical behavior for tenants without a rule).
 *     2. If mode === 'manual' or rule disabled, return no_rule (caller
 *        still falls back to legacy or errors as it always did).
 *     3. Compute eligibility (availability + freebusy + service pool +
 *        optional rule pool).
 *     4. Dispatch to the mode's picker.
 *     5. Return {ok:true, staffId, mode, reason}.
 *
 * NEVER throws. Booking-route caller wraps in try/catch as defense in
 * depth, but the orchestrator itself returns structured results for
 * every failure path.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { staffAssignmentRules } from "@/db/schema";

import { getEligibleStaff } from "./eligibility";
import { pickLeastBusy } from "./leastBusy";
import { pickPriority } from "./priority";
import { pickRoundRobin } from "./roundRobin";
import {
  type AssignStaffInput,
  type AssignStaffResult,
  type RoutingMode,
  type RoutingRule,
} from "./types";
import { pickWeighted } from "./weighted";

export async function assignStaff(input: AssignStaffInput): Promise<AssignStaffResult> {
  try {
    const rule = await loadApplicableRule(input);
    if (!rule || !rule.enabled || rule.mode === "manual") {
      return {
        ok: false,
        mode: rule?.mode ?? "no_rule",
        reason: rule
          ? rule.enabled
            ? "manual_mode_fallback_to_legacy"
            : "rule_disabled"
          : "no_rule",
      };
    }

    // Pool for priority/weighted is the rule's configured list. The
    // other modes get the full service pool (eligibility narrows it).
    const restrictTo =
      rule.mode === "priority"
        ? rule.priorityOrder
        : rule.mode === "weighted"
        ? Object.keys(rule.weightedDistribution)
        : undefined;

    const eligible = await getEligibleStaff({
      tenantId: input.tenantId,
      serviceId: input.serviceId,
      startAt: input.startAt,
      endAt: input.endAt,
      restrictTo,
    });
    if (eligible.length === 0) {
      return { ok: false, mode: rule.mode, reason: "no_available_staff" };
    }

    let pick: string | null = null;
    let reason: string = "";
    switch (rule.mode) {
      case "round_robin":
        pick = await pickRoundRobin({ tenantId: input.tenantId, eligible });
        reason = `round_robin among ${eligible.length} eligible`;
        break;
      case "least_busy":
        pick = await pickLeastBusy({ tenantId: input.tenantId, eligible });
        reason = `least_busy among ${eligible.length} eligible`;
        break;
      case "priority":
        pick = pickPriority({ priorityOrder: rule.priorityOrder, eligible });
        reason = pick
          ? `priority position ${rule.priorityOrder.indexOf(pick) + 1} of ${rule.priorityOrder.length}`
          : "no priority match";
        break;
      case "weighted":
        pick = await pickWeighted({
          tenantId: input.tenantId,
          eligible,
          weights: rule.weightedDistribution,
        });
        reason = "weighted_deficit_corrected";
        break;
      default:
        // Exhaustive guard — RoutingMode is closed; unreachable.
        return assertNever(rule.mode);
    }

    if (!pick) {
      return { ok: false, mode: rule.mode, reason: "no_pick_in_pool" };
    }
    return { ok: true, staffId: pick, mode: rule.mode, reason };
  } catch (err) {
    // Never throw to the caller. Booking POST falls back to legacy.
    return {
      ok: false,
      mode: "no_rule",
      reason: `engine_error:${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
    };
  }
}

// ─── Rule resolution ───────────────────────────────────────────────────

/**
 * Pick the MOST SPECIFIC matching rule for the booking context:
 *   1. service-specific (service_id set, location_id null)
 *   2. location-specific (service_id null, location_id set)
 *   3. tenant default (both null)
 *
 * Returns null if no rule matches. Tenant isolation: every query is
 * filtered by tenant_id from the input — cross-tenant rule reads are
 * impossible.
 */
async function loadApplicableRule(input: AssignStaffInput): Promise<RoutingRule | null> {
  // Single query that fetches all three buckets then we pick. Cheaper
  // than three sequential queries.
  const candidates = await db
    .select()
    .from(staffAssignmentRules)
    .where(
      and(
        eq(staffAssignmentRules.tenantId, input.tenantId),
        sql`(
          (${staffAssignmentRules.serviceId} = ${input.serviceId} AND ${staffAssignmentRules.locationId} IS NULL)
          OR (${staffAssignmentRules.serviceId} IS NULL AND ${staffAssignmentRules.locationId} IS NULL)
          ${
            input.locationId
              ? sql`OR (${staffAssignmentRules.serviceId} IS NULL AND ${staffAssignmentRules.locationId} = ${input.locationId})`
              : sql``
          }
        )`
      )
    );

  if (candidates.length === 0) return null;

  // Specificity ranking — lower number wins.
  const rank = (r: typeof staffAssignmentRules.$inferSelect): number => {
    if (r.serviceId) return 0;     // service-specific (most specific)
    if (r.locationId) return 1;    // location-specific
    return 2;                       // tenant default
  };
  candidates.sort((a, b) => rank(a) - rank(b));
  const winner = candidates[0];

  return {
    id: winner.id,
    serviceId: winner.serviceId,
    locationId: winner.locationId,
    mode: winner.mode as RoutingMode,
    enabled: winner.enabled,
    priorityOrder: Array.isArray(winner.priorityOrder) ? (winner.priorityOrder as string[]) : [],
    weightedDistribution:
      winner.weightedDistribution && typeof winner.weightedDistribution === "object"
        ? (winner.weightedDistribution as Record<string, number>)
        : {},
  };
}

function assertNever(_: never): AssignStaffResult {
  return { ok: false, mode: "no_rule", reason: "unreachable" };
}
