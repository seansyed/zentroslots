/**
 * SA-6 §B — Dunning Center data.
 *
 * Tenants whose subscription is broken or at risk of being broken,
 * with retry status + recovery probability + suggested action.
 *
 * Recovery probability is a deterministic rule based on:
 *   • Number of failed payment events (more = lower recovery)
 *   • Days in past_due (longer = lower recovery)
 * NO ML. NO AI.
 *
 * Subscription aging buckets (days past_due):
 *   0-3   → "Recoverable" — 75%
 *   4-7   → "At risk"     — 50%
 *   8-14  → "High risk"   — 25%
 *   15+   → "Critical"    — 10%, suspension candidate
 *
 * NO mock data. Tenants with no failed payments don't appear in
 * the list. Empty state is honest.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

export type DunningTenant = {
  tenantId: string;
  name: string;
  slug: string;
  plan: string | null;
  mrrCents: number;
  subscriptionStatus: string | null;
  /** Number of failed billing_transactions in last 30 days. */
  failedPayments30d: number;
  /** Most recent failure timestamp. */
  lastFailureAt: string | null;
  /** Days since the most recent failure. */
  daysSinceFailure: number | null;
  /** Suggested next action label. */
  nextAction: "retry_now" | "extend_grace" | "suspend" | "monitor";
  /** Bucketed risk tier. */
  riskTier: "recoverable" | "at_risk" | "high_risk" | "critical";
  recoveryProbability: number;
  /** Estimated days until automatic suspension. Null when not at risk. */
  daysUntilSuspension: number | null;
  /** Whether the tenant has a saved payment method on file (proxy:
   *  stripeCustomerId is set). True doesn't guarantee a valid method
   *  but indicates Stripe has card-on-file capability. */
  paymentMethodOnFile: boolean;
};

export type DunningPage = {
  tenants: DunningTenant[];
  total: number;
  generatedAt: string;
  computedInMs: number;
};

function bucket(daysSinceFailure: number | null, failedPayments30d: number): {
  riskTier: DunningTenant["riskTier"];
  recoveryProbability: number;
  daysUntilSuspension: number | null;
  nextAction: DunningTenant["nextAction"];
} {
  if (daysSinceFailure === null) {
    return { riskTier: "recoverable", recoveryProbability: 75, daysUntilSuspension: null, nextAction: "monitor" };
  }
  // Base probability per failure count
  let p = failedPayments30d === 1 ? 75 : failedPayments30d === 2 ? 50 : failedPayments30d === 3 ? 25 : 10;
  // Adjust by aging
  if (daysSinceFailure <= 3) {
    return {
      riskTier: "recoverable",
      recoveryProbability: Math.min(p, 75),
      daysUntilSuspension: 15 - daysSinceFailure,
      nextAction: "retry_now",
    };
  }
  if (daysSinceFailure <= 7) {
    return {
      riskTier: "at_risk",
      recoveryProbability: Math.min(p, 50),
      daysUntilSuspension: 15 - daysSinceFailure,
      nextAction: "retry_now",
    };
  }
  if (daysSinceFailure <= 14) {
    return {
      riskTier: "high_risk",
      recoveryProbability: Math.min(p, 25),
      daysUntilSuspension: Math.max(0, 15 - daysSinceFailure),
      nextAction: "extend_grace",
    };
  }
  return {
    riskTier: "critical",
    recoveryProbability: 10,
    daysUntilSuspension: 0,
    nextAction: "suspend",
  };
}

export async function fetchDunning(): Promise<DunningPage> {
  return memoize(
    "admin:dunning:v1",
    async () => {
      const t0 = Date.now();
      const rows = (await db.execute(
        sql`SELECT t.id::text AS tenant_id,
                   t.name,
                   t.slug,
                   t.current_plan AS plan,
                   t.subscription_status,
                   t.stripe_customer_id,
                   COALESCE(p.price_monthly_cents, 0)::int AS price_cents,
                   (SELECT COUNT(*)::int FROM billing_transactions b WHERE b.tenant_id = t.id AND b.status = 'failed' AND b.created_at > NOW() - INTERVAL '30 days') AS failed_30d,
                   (SELECT MAX(b.created_at)         FROM billing_transactions b WHERE b.tenant_id = t.id AND b.status = 'failed') AS last_failure_at
              FROM tenants t
              LEFT JOIN plans p ON p.slug = t.current_plan
             WHERE t.subscription_status IN ('past_due','canceled')
                OR EXISTS (
                  SELECT 1 FROM billing_transactions b
                   WHERE b.tenant_id = t.id
                     AND b.status = 'failed'
                     AND b.created_at > NOW() - INTERVAL '30 days'
                )
             ORDER BY t.subscription_status = 'past_due' DESC,
                      (SELECT MAX(b.created_at) FROM billing_transactions b WHERE b.tenant_id = t.id AND b.status='failed') DESC NULLS LAST
             LIMIT 100`,
      )) as unknown as Array<{
        tenant_id: string;
        name: string;
        slug: string;
        plan: string | null;
        subscription_status: string | null;
        stripe_customer_id: string | null;
        price_cents: number;
        failed_30d: number;
        last_failure_at: string | null;
      }>;

      const tenants: DunningTenant[] = rows.map((r) => {
        const failedPayments30d = Number(r.failed_30d);
        const lastFailureAt = r.last_failure_at;
        const daysSinceFailure = lastFailureAt
          ? Math.floor((Date.now() - new Date(lastFailureAt).getTime()) / (24 * 60 * 60_000))
          : null;
        const b = bucket(daysSinceFailure, failedPayments30d);
        return {
          tenantId: r.tenant_id,
          name: r.name,
          slug: r.slug,
          plan: r.plan,
          mrrCents: Number(r.price_cents),
          subscriptionStatus: r.subscription_status,
          failedPayments30d,
          lastFailureAt,
          daysSinceFailure,
          nextAction: b.nextAction,
          riskTier: b.riskTier,
          recoveryProbability: b.recoveryProbability,
          daysUntilSuspension: b.daysUntilSuspension,
          paymentMethodOnFile: !!r.stripe_customer_id,
        };
      });

      return {
        tenants,
        total: tenants.length,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    60_000,
  );
}
