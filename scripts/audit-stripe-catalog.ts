#!/usr/bin/env tsx
/**
 * audit-stripe-catalog.ts — READ-ONLY plan/price reconciliation.
 *
 *   tsx scripts/audit-stripe-catalog.ts
 *
 * Reconciles the THREE catalogs for every paid plan:
 *   1. lib/plans.ts          — the canonical registry (prices + entitlements)
 *   2. Stripe live Prices    — what customers are actually charged
 *   3. DB `plans` table      — the admin/analytics projection
 *
 * Flags any monetary disagreement. Reads Stripe via stripe.prices.retrieve
 * (no writes, no secrets printed — only price/product IDs, which are not
 * secret). Run before launch and on a periodic cron to catch drift.
 *
 * Exit codes:
 *   0 — all three catalogs agree
 *   2 — a monetary mismatch was found (launch blocker)
 *   1 — fatal error
 */

import "dotenv/config";

import { sql } from "drizzle-orm";

import { db } from "../db/client";
import { PLANS, type PlanId } from "../lib/plans";
import { getStripe, isStripeConfigured, priceIdFor } from "../lib/stripe";

function log(obj: Record<string, unknown>) {
  console.log(JSON.stringify({ ...obj, ts: new Date().toISOString() }));
}

const PAID: PlanId[] = ["solo", "pro", "team", "enterprise"];

(async () => {
  try {
    if (!isStripeConfigured()) {
      log({ evt: "catalog_audit.skipped", reason: "stripe_not_configured" });
      process.exit(0);
    }
    const stripe = await getStripe();

    // DB projection (slug -> {monthly,yearly,priceIdMonthly,priceIdYearly})
    const dbRows = (await db.execute(
      sql`SELECT slug, price_monthly_cents, price_yearly_cents, stripe_price_id_monthly, stripe_price_id_yearly FROM plans`,
    )) as unknown as Array<{
      slug: string;
      price_monthly_cents: number;
      price_yearly_cents: number;
      stripe_price_id_monthly: string | null;
      stripe_price_id_yearly: string | null;
    }>;
    const dbBySlug = new Map(dbRows.map((r) => [r.slug, r]));

    let mismatches = 0;

    for (const id of PAID) {
      const plan = PLANS[id];
      for (const interval of ["month", "year"] as const) {
        const registryCents = interval === "month" ? plan.priceCents : plan.priceCentsYearly;
        const priceId = priceIdFor(id, interval);
        const dbRow = dbBySlug.get(id);
        const dbCents = interval === "month" ? dbRow?.price_monthly_cents : dbRow?.price_yearly_cents;
        const dbPriceId = interval === "month" ? dbRow?.stripe_price_id_monthly : dbRow?.stripe_price_id_yearly;

        if (!priceId) {
          mismatches++;
          log({ evt: "catalog_audit.missing_price_id", plan: id, interval, hint: "STRIPE_PRICE_* env not set" });
          continue;
        }

        let stripeCents: number | null = null;
        let stripeActive: boolean | null = null;
        try {
          const price = await stripe.prices.retrieve(priceId);
          stripeCents = price.unit_amount ?? null;
          stripeActive = price.active;
        } catch (e) {
          mismatches++;
          log({ evt: "catalog_audit.stripe_price_error", plan: id, interval, priceId, err: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
          continue;
        }

        // registry vs Stripe (the authoritative monetary comparison)
        if (registryCents != null && stripeCents != null && registryCents !== stripeCents) {
          mismatches++;
          log({
            evt: "catalog_audit.price_mismatch",
            severity: "critical",
            plan: id,
            interval,
            registry_cents: registryCents,
            stripe_cents: stripeCents,
            priceId,
            stripe_active: stripeActive,
            hint: "Displayed (registry/pricing page) price != what Stripe will charge. Fix the Stripe price OR the registry so they agree.",
          });
        }
        // DB projection vs registry
        if (dbCents != null && registryCents != null && dbCents !== registryCents) {
          log({ evt: "catalog_audit.db_price_drift", plan: id, interval, db_cents: dbCents, registry_cents: registryCents });
        }
        // DB price-id population
        if (!dbPriceId) {
          log({ evt: "catalog_audit.db_price_id_unpopulated", plan: id, interval, hint: "run scripts/seed-plan-price-ids.ts to populate plans.stripe_price_id_*" });
        } else if (dbPriceId !== priceId) {
          log({ evt: "catalog_audit.db_price_id_drift", plan: id, interval, db_price_id: dbPriceId, env_price_id: priceId });
        }
      }
    }

    log({ evt: "catalog_audit.summary", paidPlans: PAID.length, monetaryMismatches: mismatches });
    process.exit(mismatches > 0 ? 2 : 0);
  } catch (err) {
    log({ evt: "catalog_audit.fatal", err: err instanceof Error ? err.message.slice(0, 500) : "unknown" });
    process.exit(1);
  }
})();
