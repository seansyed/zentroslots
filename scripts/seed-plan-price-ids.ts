#!/usr/bin/env tsx
/**
 * seed-plan-price-ids.ts — populate the DB `plans` projection's Stripe price IDs.
 *
 *   tsx scripts/seed-plan-price-ids.ts [--dry-run]
 *
 * The `plans` table's stripe_price_id_monthly/yearly columns ship NULL (the
 * 0065/0066 seeds never set them). Checkout/webhook/entitlements do NOT read
 * them (they use lib/plans.ts + env), so this is a DECORATIVE projection used
 * by admin analytics. This seed resolves each paid plan's price ID from the
 * SAME canonical source checkout uses (priceIdFor → env) and writes it to the
 * DB so the admin view matches reality.
 *
 * Idempotent + re-runnable. No price IDs are hardcoded (resolved from env at
 * runtime). Run on prod AFTER a DB backup. Does NOT touch prices/entitlements.
 */

import "dotenv/config";

import { eq } from "drizzle-orm";

import { db } from "../db/client";
import { plans } from "../db/schema";
import { priceIdFor } from "../lib/stripe";
import type { PlanId } from "../lib/plans";

const dryRun = process.argv.slice(2).includes("--dry-run");

function log(obj: Record<string, unknown>) {
  console.log(JSON.stringify({ ...obj, ts: new Date().toISOString() }));
}

const PAID: PlanId[] = ["solo", "pro", "team", "enterprise"];

(async () => {
  try {
    let updated = 0;
    let skipped = 0;
    for (const id of PAID) {
      const monthly = priceIdFor(id, "month");
      const yearly = priceIdFor(id, "year");
      if (!monthly && !yearly) {
        skipped++;
        log({ evt: "seed_price_ids.skip", plan: id, reason: "no env price ids resolved" });
        continue;
      }
      log({ evt: "seed_price_ids.plan", plan: id, monthly: monthly ?? null, yearly: yearly ?? null, dryRun });
      if (!dryRun) {
        await db
          .update(plans)
          .set({
            stripePriceIdMonthly: monthly ?? null,
            stripePriceIdYearly: yearly ?? null,
          })
          .where(eq(plans.slug, id));
        updated++;
      }
    }
    log({ evt: "seed_price_ids.summary", updated, skipped, dryRun });
    process.exit(0);
  } catch (err) {
    log({ evt: "seed_price_ids.fatal", err: err instanceof Error ? err.message.slice(0, 500) : "unknown" });
    process.exit(1);
  }
})();
