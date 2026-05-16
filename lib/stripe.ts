/**
 * Stripe wrapper. Initialized lazily — without STRIPE_SECRET_KEY, every
 * function throws a clear "demo mode" error that routes catch and surface
 * to the UI. No real Stripe calls happen until keys are provided.
 */

import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants, type Tenant } from "@/db/schema";
import { getPlan, type PlanId } from "@/lib/plans";

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

export function priceIdFor(planId: PlanId): string | null {
  const plan = getPlan(planId);
  if (!plan.stripePriceEnvVar) return null;
  return process.env[plan.stripePriceEnvVar] ?? null;
}
