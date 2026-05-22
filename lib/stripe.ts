/**
 * Stripe wrapper. Initialized lazily — without STRIPE_SECRET_KEY, every
 * function throws a clear "demo mode" error that routes catch and surface
 * to the UI. No real Stripe calls happen until keys are provided.
 */

import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants, type Tenant } from "@/db/schema";
import { getPlan, PLANS, type PlanId } from "@/lib/plans";

let _stripe: Stripe | null = null;
let _initTried = false;

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export async function getStripe(): Promise<Stripe> {
  if (_stripe) return _stripe;
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe is not configured (set STRIPE_SECRET_KEY)");
  }
  if (!_initTried) {
    _initTried = true;
    const { default: StripeMod } = await import("stripe");
    _stripe = new StripeMod(process.env.STRIPE_SECRET_KEY, {
      // Pin API version — let the SDK pick its default rather than
      // hardcoding a string that could drift out of date.
    });
  }
  return _stripe!;
}

/** Ensure the tenant has a Stripe customer; create on first need. */
export async function ensureStripeCustomer(tenant: Tenant, emailFallback: string): Promise<string> {
  if (tenant.stripeCustomerId) return tenant.stripeCustomerId;
  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    email: tenant.billingEmail ?? emailFallback,
    name: tenant.name,
    metadata: { tenantId: tenant.id, slug: tenant.slug },
  });
  await db
    .update(tenants)
    .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
    .where(eq(tenants.id, tenant.id));
  return customer.id;
}

/**
 * Phase 16B — reverse lookup: given a Stripe Price ID from a webhook
 * event, derive the plan + billing interval.
 *
 * This is the OPPOSITE of priceIdFor(). Used by the Stripe webhook to
 * translate `subscription.items[0].price.id` back into a plan slug we
 * can persist on `tenants.currentPlan`.
 *
 * Lookup order per plan:
 *   1. Phase-16A monthly env var (`stripePriceEnvMonthly`)
 *   2. Phase-16A yearly env var (`stripePriceEnvYearly`)
 *   3. Legacy monthly env var (`stripePriceEnvVar`) — preserved so
 *      existing subscriptions on the pre-Phase-16 prices keep being
 *      recognized after the catalog redefinition.
 *
 * Returns null when the price ID doesn't match ANY configured env
 * var. The webhook caller then leaves `currentPlan` unchanged
 * instead of clobbering it — defensive against new Stripe products
 * the catalog doesn't know about yet.
 */
export function planFromStripePriceId(
  priceId: string | null | undefined,
): { plan: PlanId; interval: "month" | "year" } | null {
  if (!priceId) return null;
  // Walk every plan in the catalog. The interval-specific env vars
  // are checked first so a newly-wired monthly Pro Price ID wins
  // over the legacy fallback.
  const planIds = Object.keys(PLANS) as PlanId[];
  for (const planId of planIds) {
    const plan = getPlan(planId);
    if (plan.stripePriceEnvMonthly) {
      const envVal = process.env[plan.stripePriceEnvMonthly];
      if (envVal && envVal === priceId) {
        return { plan: planId, interval: "month" };
      }
    }
    if (plan.stripePriceEnvYearly) {
      const envVal = process.env[plan.stripePriceEnvYearly];
      if (envVal && envVal === priceId) {
        return { plan: planId, interval: "year" };
      }
    }
    // Legacy fallback — only meaningful for the two pre-Phase-16
    // env vars (STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM). Treated as
    // monthly because the legacy keys always were.
    if (plan.stripePriceEnvVar) {
      const envVal = process.env[plan.stripePriceEnvVar];
      if (envVal && envVal === priceId) {
        return { plan: planId, interval: "month" };
      }
    }
  }
  return null;
}

/**
 * Phase 16B — diagnostic snapshot of which Stripe Prices are
 * actually wired in this environment. Used by /api/health and
 * surfaced (booleans only — no env values leaked) on the billing
 * page so admins can see at a glance which checkout paths are live.
 *
 * Returns one entry per (planId, interval) tuple. The legacy
 * env-var-only path is included under `legacyMonthly` for
 * monitoring during the migration window.
 */
export function billingConfigSnapshot(): {
  stripeKey: boolean;
  webhookSecret: boolean;
  prices: Record<
    PlanId,
    {
      monthly: boolean;
      yearly: boolean;
      legacyMonthly: boolean;
    }
  >;
} {
  const planIds = Object.keys(PLANS) as PlanId[];
  const prices = {} as Record<
    PlanId,
    { monthly: boolean; yearly: boolean; legacyMonthly: boolean }
  >;
  for (const id of planIds) {
    const plan = getPlan(id);
    prices[id] = {
      monthly: !!(plan.stripePriceEnvMonthly && process.env[plan.stripePriceEnvMonthly]),
      yearly: !!(plan.stripePriceEnvYearly && process.env[plan.stripePriceEnvYearly]),
      legacyMonthly: !!(plan.stripePriceEnvVar && process.env[plan.stripePriceEnvVar]),
    };
  }
  return {
    stripeKey: !!process.env.STRIPE_SECRET_KEY,
    webhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET,
    prices,
  };
}

/**
 * Resolve the Stripe Price ID for a plan + billing interval.
 *
 * Lookup order:
 *   1. New interval-specific env var (`stripePriceEnvMonthly` /
 *      `stripePriceEnvYearly` from Phase 16A). Once the operator
 *      creates the new Stripe Prices and pastes their IDs into
 *      `.env`, these become the source of truth.
 *   2. Legacy `stripePriceEnvVar` (monthly-only). Kept as a fallback
 *      so existing subscriptions on the pre-Phase-16 prices keep
 *      checking out cleanly when no interval is requested.
 *   3. null → caller should surface a "Stripe price not configured"
 *      state. NEVER substitute a fake or sibling-plan price.
 *
 * `interval` defaults to "month" so all pre-Phase-16 callers (which
 * pass no interval at all) continue routing to the same Stripe Price
 * they always did.
 */
export function priceIdFor(
  planId: PlanId,
  interval: "month" | "year" = "month",
): string | null {
  const plan = getPlan(planId);

  // Yearly path — only the new env var counts. No fallback to legacy
  // because the legacy env var has always been monthly.
  if (interval === "year") {
    if (!plan.stripePriceEnvYearly) return null;
    return process.env[plan.stripePriceEnvYearly] ?? null;
  }

  // Monthly path — prefer the new env var, then fall back to legacy.
  if (plan.stripePriceEnvMonthly) {
    const fromNew = process.env[plan.stripePriceEnvMonthly];
    if (fromNew) return fromNew;
  }
  if (plan.stripePriceEnvVar) {
    return process.env[plan.stripePriceEnvVar] ?? null;
  }
  return null;
}
