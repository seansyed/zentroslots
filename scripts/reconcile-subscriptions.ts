#!/usr/bin/env tsx
/**
 * reconcile-subscriptions.ts — READ-ONLY DB ↔ Stripe subscription reconciler.
 *
 *   tsx scripts/reconcile-subscriptions.ts [--dry-run] [--limit=N]
 *
 * For every tenant that carries a stripe_subscription_id, retrieve the live
 * Stripe subscription and compare it against the DB columns that actually have
 * a home on `tenants` (subscription_status, current_plan, trial_end). Reports
 * drift; NEVER mutates the DB or Stripe (no tenants.update, no Stripe writes —
 * only stripe.subscriptions.retrieve). current_period_end / cancel_at_period_end
 * are emitted as INFORMATIONAL metadata only (no DB column to compare to).
 *
 * Mirrors the conventions of scripts/reconcile-tenant-payments.ts.
 * Safe to run on a daily cron (operator enables after observing output).
 *
 * Exit codes:
 *   0 — completed, no critical drift
 *   2 — completed, CRITICAL drift found (e.g. Stripe cancelled but DB still paid)
 *   1 — fatal error during the run
 *
 * Output: one-line JSON per finding + a final summary line. No secrets are
 * printed (sub_…/cus_… IDs are non-secret; the API key is never logged).
 */

import "dotenv/config";

import { eq, isNotNull } from "drizzle-orm";

import { db } from "../db/client";
import { tenants } from "../db/schema";
import { getStripe, isStripeConfigured, planFromStripePriceId } from "../lib/stripe";
import { adminNotify } from "../lib/admin-notify";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const limitArg = argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1])) : undefined;

function log(obj: Record<string, unknown>) {
  console.log(JSON.stringify({ ...obj, ts: new Date().toISOString() }));
}

/** Cancelled/dead Stripe states that should NOT coexist with a paid DB plan. */
const DEAD_STRIPE_STATES = new Set(["canceled", "unpaid", "incomplete_expired"]);

(async () => {
  try {
    if (!isStripeConfigured()) {
      log({ evt: "reconcile_subs.skipped", reason: "stripe_not_configured" });
      process.exit(0);
    }

    log({ evt: "reconcile_subs.start", dryRun, limit: limit ?? null });

    let rows = await db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        currentPlan: tenants.currentPlan,
        subscriptionStatus: tenants.subscriptionStatus,
        trialEnd: tenants.trialEnd,
        stripeCustomerId: tenants.stripeCustomerId,
        stripeSubscriptionId: tenants.stripeSubscriptionId,
      })
      .from(tenants)
      .where(isNotNull(tenants.stripeSubscriptionId));

    if (limit) rows = rows.slice(0, limit);

    const stripe = await getStripe();
    let scanned = 0;
    let ok = 0;
    let mismatches = 0;
    let criticals = 0;
    let errors = 0;

    for (const t of rows) {
      scanned++;
      // Per-tenant isolation: one tenant's Stripe error never aborts the run
      // or bleeds into another tenant's finding.
      try {
        const sub = await stripe.subscriptions.retrieve(t.stripeSubscriptionId!);
        const stripeStatus = sub.status;
        // current_period_end / cancel_at_period_end are informational only (no
        // DB column to compare). Access via a loose cast — their position on the
        // Subscription object varies across Stripe API/SDK versions.
        const period = sub as unknown as { current_period_end?: number | null; cancel_at_period_end?: boolean };
        const priceId = sub.items?.data?.[0]?.price?.id ?? null;
        const expectedPlan = planFromStripePriceId(priceId)?.plan ?? null; // null => unknown price, leave alone (webhook does the same)
        const stripeTrialEndSec = sub.trial_end ?? 0;
        const dbTrialEndSec = t.trialEnd ? Math.floor(t.trialEnd.getTime() / 1000) : 0;

        const drift: string[] = [];
        if (t.subscriptionStatus !== stripeStatus) drift.push("status");
        if (expectedPlan !== null && t.currentPlan !== expectedPlan) drift.push("plan");
        if (stripeTrialEndSec !== dbTrialEndSec) drift.push("trial_end");

        if (drift.length === 0) {
          ok++;
          continue;
        }

        // CRITICAL = Stripe says the subscription is dead but the DB still
        // shows the tenant on a paid plan (active over-provisioning / revenue leak).
        const critical =
          DEAD_STRIPE_STATES.has(stripeStatus) && t.currentPlan !== "free" && t.currentPlan != null;
        mismatches++;
        if (critical) criticals++;

        log({
          evt: "reconcile_subs.mismatch",
          severity: critical ? "critical" : "warning",
          tenantId: t.id,
          tenantSlug: t.slug,
          subscriptionId: t.stripeSubscriptionId,
          customerId: t.stripeCustomerId,
          drift,
          db_status: t.subscriptionStatus,
          stripe_status: stripeStatus,
          db_plan: t.currentPlan,
          stripe_plan: expectedPlan,
          unknown_price: expectedPlan === null ? priceId : undefined,
          // informational only — no DB column to compare against:
          stripe_current_period_end: period.current_period_end
            ? new Date(period.current_period_end * 1000).toISOString()
            : null,
          stripe_cancel_at_period_end: period.cancel_at_period_end ?? null,
        });

        if (!dryRun) {
          void adminNotify({
            kind: "subscription_reconcile_drift",
            severity: critical ? "critical" : "warning",
            summary: `Subscription drift (${drift.join(",")}) — DB ${t.currentPlan}/${t.subscriptionStatus} vs Stripe ${expectedPlan ?? "?"}/${stripeStatus}`,
            tenantId: t.id,
            dedupeKey: `subscription_reconcile_drift::${t.id}::${t.stripeSubscriptionId}`,
            metadata: {
              db_status: t.subscriptionStatus,
              stripe_status: stripeStatus,
              db_plan: t.currentPlan,
              stripe_plan: expectedPlan,
            },
          });
        }
      } catch (err) {
        errors++;
        log({
          evt: "reconcile_subs.tenant_error",
          tenantId: t.id,
          subscriptionId: t.stripeSubscriptionId,
          err: err instanceof Error ? err.message.slice(0, 300) : "unknown",
        });
      }
    }

    log({ evt: "reconcile_subs.summary", scanned, ok, mismatches, criticals, errors, dryRun });
    process.exit(criticals > 0 ? 2 : 0);
  } catch (err) {
    log({ evt: "reconcile_subs.fatal", err: err instanceof Error ? err.message.slice(0, 500) : "unknown" });
    process.exit(1);
  }
})();
