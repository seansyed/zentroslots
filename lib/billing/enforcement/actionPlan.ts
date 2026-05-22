/**
 * Downgrade action planner.
 *
 * Pure(-ish) function. Reads the tenant's current state + resolves
 * per-capability policy + emits a deterministic list of actions that
 * WOULD be taken if the executor runs.
 *
 * No mutation. Safe to call from admin tools, dry-run scripts, or the
 * Stripe webhook for observability.
 *
 * Two consumers today:
 *   1. `scripts/preview-downgrade.ts` — prints the plan; ops review.
 *   2. `scripts/apply-downgrade.ts` — generates the plan, then hands
 *      it to the executor.
 *
 * Why split planner from executor:
 *   - Dry-run becomes trivial (build plan; print it; never call executor).
 *   - Audit log can record the planned actions BEFORE attempting them
 *     ("we intended to do X, Y, Z").
 *   - Per-feature handlers stay focused on the WHAT, not the WHY.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import { bookingSeries } from "@/db/schema";
import type { Capability } from "@/lib/billing/capabilities";
import { capabilitySnapshot } from "@/lib/billing/capabilities";
import { getPlan, type PlanId } from "@/lib/plans";

import { resolveAllPolicies } from "./policies";
import {
  type DowngradeAction,
  type DowngradeActionKind,
  type DowngradePlan,
  type EnforcementMode,
} from "./types";

/**
 * Build the action plan for a tenant transitioning from `fromPlan` to
 * `toPlan` (or, when called with same plan, the current "what's
 * over-cap right now" snapshot).
 *
 * The planner emits one action PER feature that:
 *   - the toPlan does NOT unlock (i.e., now over-cap), AND
 *   - has a resolved policy of "grandfathered" or "hard"
 *
 * "Soft" mode emits no action — the write-side gates (Phase 1) already
 * block new creates; soft mode adds only a UI warning that doesn't
 * require a row-level mutation.
 *
 * Returns the plan WITH `entityIds` populated so the executor's audit
 * row can name the exact rows it would touch.
 */
export async function planDowngrade(args: {
  tenantId: string;
  fromPlan: PlanId;
  toPlan: PlanId;
  eventId: string;
  db?: typeof defaultDb;
  now?: Date;
}): Promise<DowngradePlan> {
  const { tenantId, fromPlan, toPlan, eventId, db = defaultDb, now = new Date() } = args;

  const toPlanObj = getPlan(toPlan);
  const targetCapabilities = capabilitySnapshot(toPlanObj);
  const policies = await resolveAllPolicies({ tenantId, db, now });

  const actions: DowngradeAction[] = [];

  // Iterate every capability. If the destination plan does NOT unlock
  // it AND the policy is grandfathered/hard, emit the appropriate
  // action(s). Iteration is deterministic (Object.keys order is stable
  // per ES spec for string keys; the DEFAULT_ENFORCEMENT_POLICY insertion
  // order is the canonical sequence).
  for (const cap of Object.keys(targetCapabilities) as Capability[]) {
    const check = targetCapabilities[cap];
    if (check.allowed) continue; // toPlan still unlocks this — no action

    const policy = policies[cap];
    if (policy.mode === "soft") continue; // soft = UI warning only

    const featureActions = await planForCapability({
      cap,
      mode: policy.mode,
      tenantId,
      db,
    });
    for (const a of featureActions) actions.push(a);
  }

  return {
    tenantId,
    fromPlan,
    toPlan,
    eventId,
    actions,
    summary: summarize(actions, fromPlan, toPlan),
  };
}

/**
 * Resolve the row-level entityIds for a single capability's actions.
 * Each capability has its own row source. Returning an empty entityIds
 * list is fine — the action is still emitted so the audit trail shows
 * "we considered this; nothing to do."
 */
async function planForCapability(args: {
  cap: Capability;
  mode: EnforcementMode;
  tenantId: string;
  db: typeof defaultDb;
}): Promise<DowngradeAction[]> {
  const { cap, mode, tenantId, db } = args;
  const out: DowngradeAction[] = [];

  switch (cap) {
    case "recurring_series": {
      // Only HARD pauses active series; GRANDFATHERED leaves them
      // executing (Phase 2 cron continues materializing the
      // grandfathered ones). Either mode emits an action though —
      // GRANDFATHERED yields a zero-id "noop" action that the audit
      // log captures for completeness.
      if (mode === "hard") {
        const rows = await db
          .select({ id: bookingSeries.id })
          .from(bookingSeries)
          .where(
            and(
              eq(bookingSeries.tenantId, tenantId),
              eq(bookingSeries.status, "active"),
              isNull(bookingSeries.enforcementPausedAt),
            ),
          );
        out.push({
          kind: "pause_recurring_series",
          capability: cap,
          mode,
          entityIds: rows.map((r) => r.id),
          description: `Pause ${rows.length} active recurring series`,
        });
      } else {
        // grandfathered — explicit no-action marker for the audit log.
        out.push(makeNoopAction("pause_recurring_series", cap, mode,
          "Grandfathered: existing recurring series continue to materialize."));
      }
      break;
    }

    case "automation_rules":
      out.push(makeStubAction("disable_automation_rules", cap, mode));
      break;
    case "routing_rules":
      out.push(makeStubAction("disable_routing_rules_premium_modes", cap, mode));
      break;
    case "custom_domains":
      out.push(makeStubAction("deactivate_custom_domains", cap, mode));
      break;
    case "booking_rules":
      // Booking rules have no destructive enforcement — they only
      // affect the booking validation engine, which runs per request.
      // Grandfather/hard distinction is irrelevant; nothing to pause.
      out.push(makeNoopAction("disable_automation_rules", cap, mode,
        "Booking rules continue to evaluate; gate is at write time only."));
      break;
    case "scheduled_reports":
      out.push(makeStubAction("disable_automation_rules", cap, mode));
      break;
    case "analytics_export":
      // Read action — no row state to pause. Always emit a marker
      // action for the audit log.
      out.push(makeNoopAction("lock_analytics_export", cap, mode,
        "Analytics export already 402s at the route on Free/Solo plans."));
      break;
    case "hide_powered_by":
      // Toggle, not a row collection. The UI re-reads the flag from
      // plan limits on every render; no row-level action needed.
      out.push(makeNoopAction("freeze_excess_locations", cap, mode,
        "hide_powered_by is plan-derived; no row state to pause."));
      break;
  }

  return out;
}

function makeNoopAction(
  kind: DowngradeActionKind,
  capability: Capability,
  mode: EnforcementMode,
  description: string,
): DowngradeAction {
  return { kind, capability, mode, entityIds: [], description };
}

function makeStubAction(
  kind: DowngradeActionKind,
  capability: Capability,
  mode: EnforcementMode,
): DowngradeAction {
  return {
    kind,
    capability,
    mode,
    entityIds: [],
    description: `[Handler stub] ${kind} — execution lands in a follow-up phase.`,
  };
}

function summarize(actions: DowngradeAction[], fromPlan: PlanId, toPlan: PlanId): string {
  if (actions.length === 0) return `No enforcement actions: ${fromPlan} → ${toPlan} is a no-op.`;
  const affected = actions.reduce((sum, a) => sum + a.entityIds.length, 0);
  return `${actions.length} planned action(s), ${affected} row(s) affected (${fromPlan} → ${toPlan}).`;
}
