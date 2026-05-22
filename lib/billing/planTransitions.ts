/**
 * Plan transition observability + downgrade detection.
 *
 * Wraps a tenants-table mutation triggered by a Stripe webhook and:
 *   1. Reads the OLD plan / subscription state BEFORE applying the change
 *   2. Applies the mutation (delegated to a caller-provided function)
 *   3. Reads the NEW state
 *   4. If anything changed, emits a `billing.plan_transition` audit row
 *   5. If the plan tier DECREASED, emits a `billing.downgrade_applied`
 *      audit row with the grandfathered-row inventory snapshot
 *   6. If the plan tier INCREASED, emits a `billing.upgrade_applied`
 *      audit row
 *
 * Why a single helper:
 *   - Webhook handler stays linear — every event type calls
 *     `applyTenantMutation(tenantId, mutation)` and gets observability
 *     for free.
 *   - Audit + inventory snapshots are best-effort (try/catch wrapped) so
 *     a logging failure NEVER causes the webhook to 500 (Stripe would
 *     retry indefinitely).
 *
 * Note on idempotency:
 *   This helper does NOT itself dedupe. Caller must claim the event_id
 *   via `tryClaimStripeEvent()` BEFORE calling here. Otherwise a
 *   duplicate webhook would (correctly) write the same mutation but
 *   would (incorrectly) emit a second audit row.
 */
import { eq } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import { tenants } from "@/db/schema";
import { audit } from "@/lib/audit";
import { PLAN_RANK, type PlanId } from "@/lib/plans";
import { listGrandfatheredRowCounts } from "@/lib/billing/grandfathered";

export type TenantBillingState = {
  currentPlan: string;
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

export type TransitionAuditContext = {
  /** Stripe event ID — included in audit metadata for grep / replay
   *  forensics. */
  stripeEventId: string;
  /** Stripe event type ("customer.subscription.updated", etc.). */
  stripeEventType: string;
};

export type MutationResult = {
  /** True if the row's billing state actually changed. False when
   *  the mutation was a no-op (same plan + same status + same
   *  subscription id). */
  changed: boolean;
  before: TenantBillingState | null;
  after: TenantBillingState | null;
};

/**
 * Run a tenant mutation with before/after observability + transition
 * audit emission. The `mutation` callback performs the actual DB write
 * — typically `db.update(tenants).set({ ... }).where(eq(tenants.id, tenantId))`.
 *
 * Returns the resolved before/after state so the caller can log /
 * branch on the change. Returns `changed: false` when the tenant row
 * doesn't exist (the mutation would be a no-op) — defensive against
 * webhook events arriving before tenant signup completes.
 */
export async function applyTenantBillingMutation(args: {
  tenantId: string;
  ctx: TransitionAuditContext;
  mutation: (db: typeof defaultDb) => Promise<void>;
  db?: typeof defaultDb;
}): Promise<MutationResult> {
  const { tenantId, ctx, mutation, db = defaultDb } = args;

  const before = await readBillingState(tenantId, db);
  if (!before) {
    // Tenant row missing — defensive. Mutation might create it via
    // INSERT or it might be a stale event we should ignore. We still
    // run the mutation in case it's an UPSERT, but don't try to read
    // after.
    await mutation(db);
    return { changed: false, before: null, after: null };
  }

  await mutation(db);

  const after = await readBillingState(tenantId, db);
  if (!after) {
    return { changed: false, before, after: null };
  }

  const changed =
    before.currentPlan !== after.currentPlan ||
    before.subscriptionStatus !== after.subscriptionStatus ||
    before.stripeSubscriptionId !== after.stripeSubscriptionId;

  if (changed) {
    await emitTransitionAudits({
      tenantId,
      before,
      after,
      ctx,
      db,
    });
  }

  return { changed, before, after };
}

async function readBillingState(
  tenantId: string,
  db: typeof defaultDb,
): Promise<TenantBillingState | null> {
  const row = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: {
      currentPlan: true,
      subscriptionStatus: true,
      stripeCustomerId: true,
      stripeSubscriptionId: true,
    },
  });
  return row ?? null;
}

async function emitTransitionAudits(args: {
  tenantId: string;
  before: TenantBillingState;
  after: TenantBillingState;
  ctx: TransitionAuditContext;
  db: typeof defaultDb;
}): Promise<void> {
  const { tenantId, before, after, ctx, db } = args;

  // Always emit the generic plan_transition row — gives ops a full
  // diff trail in audit_logs WITHOUT replacing the billing_transactions
  // financial ledger (different concerns: ledger = $$, audit = state).
  try {
    await audit({
      tenantId,
      action: "billing.plan_transition",
      actorLabel: `stripe:${ctx.stripeEventType}`,
      entityType: "billing",
      entityId: ctx.stripeEventId,
      metadata: {
        stripe_event_id: ctx.stripeEventId,
        stripe_event_type: ctx.stripeEventType,
        from: {
          plan: before.currentPlan,
          subscriptionStatus: before.subscriptionStatus,
          stripeSubscriptionId: before.stripeSubscriptionId,
        },
        to: {
          plan: after.currentPlan,
          subscriptionStatus: after.subscriptionStatus,
          stripeSubscriptionId: after.stripeSubscriptionId,
        },
      },
    });
  } catch (e) {
    console.warn(`[plan-transitions] audit failed for ${tenantId}:`, e);
  }

  // If the plan tier shifted, emit the directional audit + (for
  // downgrades) snapshot the grandfathered exposure.
  const beforeRank = rankFor(before.currentPlan);
  const afterRank = rankFor(after.currentPlan);
  if (beforeRank === null || afterRank === null) return;

  if (afterRank > beforeRank) {
    try {
      await audit({
        tenantId,
        action: "billing.upgrade_applied",
        actorLabel: `stripe:${ctx.stripeEventType}`,
        entityType: "billing",
        entityId: ctx.stripeEventId,
        metadata: {
          stripe_event_id: ctx.stripeEventId,
          from_plan: before.currentPlan,
          to_plan: after.currentPlan,
        },
      });
    } catch (e) {
      console.warn(`[plan-transitions] upgrade audit failed for ${tenantId}:`, e);
    }
    return;
  }

  if (afterRank < beforeRank) {
    // Downgrade — snapshot the grandfathered-row inventory so ops can
    // see WHAT premium artifacts the tenant is now over-cap on. This
    // is read-only (no auto-pause); the user's stated policy is to
    // grandfather existing rows. The audit log gives them visibility
    // for free.
    let inventory: Awaited<ReturnType<typeof listGrandfatheredRowCounts>> | null = null;
    try {
      inventory = await listGrandfatheredRowCounts({ tenantId, db });
    } catch (e) {
      console.warn(`[plan-transitions] grandfather inventory failed for ${tenantId}:`, e);
    }
    try {
      await audit({
        tenantId,
        action: "billing.downgrade_applied",
        actorLabel: `stripe:${ctx.stripeEventType}`,
        entityType: "billing",
        entityId: ctx.stripeEventId,
        metadata: {
          stripe_event_id: ctx.stripeEventId,
          from_plan: before.currentPlan,
          to_plan: after.currentPlan,
          grandfathered_inventory: inventory
            ? {
                clean: inventory.clean,
                rows: inventory.rows,
              }
            : null,
        },
      });
    } catch (e) {
      console.warn(`[plan-transitions] downgrade audit failed for ${tenantId}:`, e);
    }
  }
}

function rankFor(plan: string): number | null {
  if (plan in PLAN_RANK) return PLAN_RANK[plan as PlanId];
  return null;
}
