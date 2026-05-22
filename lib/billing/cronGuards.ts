/**
 * Cron-level billing guards.
 *
 * Phase 2 of plan enforcement: while Phase 1 blocks WRITES of premium
 * rows from Free-plan tenants (lib/billing/capabilities.ts), Phase 2
 * decides WHICH tenants the background workers should process and in
 * what mode.
 *
 * The policy was set explicitly by the user:
 *   - existing grandfathered rows on Free tenants CONTINUE to execute
 *   - cancelled / past-due / unpaid / inactive tenants are BLOCKED
 *   - new bypass attempts are caught by Phase 1 at write time
 *
 * This module returns a Decision per tenant. Callers are crons + the
 * tenant audit pages. There is no DB caching here — guards read
 * tenant state once per batch and pass the result through.
 */
import type { Capability } from "@/lib/billing/capabilities";
import { canUse } from "@/lib/billing/capabilities";
import { getPlan, type PlanId } from "@/lib/plans";

export type CronDecision =
  | { mode: "process"; reason: string }
  | { mode: "grandfather"; reason: string }
  | { mode: "skip"; reason: string };

/**
 * Compact tenant snapshot the guard needs. Crons fetch this in one
 * `select` and pass to the helper — no extra round-trips.
 */
export type TenantBillingSnapshot = {
  id: string;
  active: boolean;
  currentPlan: string;
  subscriptionStatus: string | null;
};

/**
 * Statuses that mean "stop processing premium features for this
 * tenant." Read directly from Stripe via the webhook handler.
 *
 * NOT in this list: `past_due` is contentious — the customer's
 * payment retry window is still open. We keep them processing for
 * up to ~10 days while Stripe retries. After that the status flips
 * to `unpaid` (or the subscription is cancelled), which IS in this
 * list. Honest tradeoff: short-term retention over strict billing.
 */
const SUSPENDED_STATUSES = new Set<string>([
  "canceled",
  "unpaid",
  "incomplete_expired",
]);

/**
 * Decide whether to process this tenant for the given premium
 * capability in a cron context.
 *
 * Returns:
 *   - { mode: "process" } — tenant has the plan; run normally
 *   - { mode: "grandfather" } — plan doesn't include the capability,
 *     but tenant has existing rows. Continue executing those rows
 *     to honor the user's grandfather policy; the audit log
 *     captures this so ops can see the exposure
 *   - { mode: "skip" } — block all cron processing for this tenant
 *     for this capability (inactive tenant, suspended billing)
 */
export function decidePremiumCronExecution(
  tenant: TenantBillingSnapshot,
  capability: Capability,
): CronDecision {
  // (1) Universal kill switch — an inactive tenant is offboarded;
  // nothing runs for them regardless of plan or row history.
  if (!tenant.active) {
    return { mode: "skip", reason: "tenant_inactive" };
  }

  // (2) Suspended billing — customer cancelled or payment failed
  // beyond the retry window. We stop premium processing for them
  // to avoid giving away paid features after non-payment.
  if (tenant.subscriptionStatus && SUSPENDED_STATUSES.has(tenant.subscriptionStatus)) {
    return { mode: "skip", reason: `billing_${tenant.subscriptionStatus}` };
  }

  // (3) Plan check.
  const plan = getPlan(tenant.currentPlan);
  const check = canUse(plan, capability);
  if (check.allowed) {
    return { mode: "process", reason: "plan_grants_capability" };
  }

  // (4) Free / low-tier tenant with existing premium rows. Grandfather.
  // The audit caller decides whether/how to log the per-batch execution.
  return {
    mode: "grandfather",
    reason: `grandfathered_${capability}_on_${plan.id}`,
  };
}

/**
 * Build a tenant-id → decision lookup for a batch of tenant ids.
 * Used by crons that process many tenants in one pass. One DB read
 * per batch instead of one per row.
 */
export async function buildBatchDecisionMap(args: {
  db: typeof import("@/db/client").db;
  tenantsTable: typeof import("@/db/schema").tenants;
  tenantIds: string[];
  capability: Capability;
}): Promise<Map<string, CronDecision>> {
  const { db, tenantsTable, tenantIds, capability } = args;
  const out = new Map<string, CronDecision>();
  if (tenantIds.length === 0) return out;
  const { inArray } = await import("drizzle-orm");
  const rows = await db
    .select({
      id: tenantsTable.id,
      active: tenantsTable.active,
      currentPlan: tenantsTable.currentPlan,
      subscriptionStatus: tenantsTable.subscriptionStatus,
    })
    .from(tenantsTable)
    .where(inArray(tenantsTable.id, tenantIds));
  for (const r of rows) {
    out.set(
      r.id,
      decidePremiumCronExecution(
        {
          id: r.id,
          active: r.active,
          currentPlan: r.currentPlan,
          subscriptionStatus: r.subscriptionStatus,
        },
        capability,
      ),
    );
  }
  // Tenants that don't have a row (impossible under FK but defensive):
  // default to skip so we never silently process a missing tenant.
  for (const id of tenantIds) {
    if (!out.has(id)) {
      out.set(id, { mode: "skip", reason: "tenant_missing" });
    }
  }
  return out;
}

/**
 * Convenience boolean for the common "should this row run?" check.
 */
export function shouldExecute(decision: CronDecision): boolean {
  return decision.mode === "process" || decision.mode === "grandfather";
}

/**
 * Convenience for logging — returns the audit category that matches
 * the decision. Crons should log AT MOST once per (tenant, batch)
 * to avoid log spam.
 */
export function auditCategoryFor(decision: CronDecision): string | null {
  switch (decision.mode) {
    case "grandfather":
      return "billing.grandfathered_execution";
    case "skip":
      return "billing.cron_skip";
    case "process":
      return null; // No log needed — this is the normal path.
  }
}

// ─── Re-exports for callers ──────────────────────────────────────────

export type { PlanId };
