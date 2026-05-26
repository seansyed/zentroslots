/**
 * SA-6 §D — Stripe ↔ local DB reconciliation.
 *
 * Detects mismatches between expected invariants on tenants + billing
 * data. Each finding is a real, fix-able state issue an operator
 * should resolve. NO Stripe API calls here — comparison is local
 * DB only (cheap, fast, runs every page load). Real Stripe-side
 * mismatch (Stripe says active, our DB says past_due) is detected
 * by a separate cron worker that pulls Stripe state nightly; that
 * worker is documented but not built in this commit.
 *
 * Findings emitted:
 *
 *   active_no_subscription_id
 *     tenant.subscription_status='active' AND stripe_subscription_id IS NULL.
 *     Caused by webhook lost-or-ignored on resub or by manual
 *     comp_subscription. Fix: pull subscription state from Stripe
 *     or set status='free' if intentionally comp'd.
 *
 *   past_due_no_failed_payment
 *     tenant.subscription_status='past_due' AND no failed_payment
 *     audit in last 30d. The status flag is stale or set out-of-band.
 *
 *   suspension_overdue
 *     past_due > 30 days AND active=true. Should have been suspended
 *     by automation.
 *
 *   trialing_no_trial_end
 *     trialing AND trial_end IS NULL.
 *     Webhook race or comp without end date.
 *
 *   canceled_still_active
 *     subscription_status='canceled' AND active=true AND
 *     last booking_created_at within last 7 days.
 *     Tenant flagged cancel but is still actively booking.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

export type ReconKind =
  | "active_no_subscription_id"
  | "past_due_no_failed_payment"
  | "suspension_overdue"
  | "trialing_no_trial_end"
  | "canceled_still_active";

export type ReconFinding = {
  kind: ReconKind;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  subscriptionStatus: string | null;
  detail: string;
  severity: "info" | "warning" | "critical";
  suggestedFix: "manual_stripe_sync" | "set_free" | "suspend" | "extend_trial" | "investigate";
};

export type ReconReport = {
  findings: ReconFinding[];
  generatedAt: string;
  computedInMs: number;
};

export async function computeReconReport(): Promise<ReconReport> {
  return memoize(
    "admin:recon:v1",
    async () => {
      const t0 = Date.now();
      const findings: ReconFinding[] = [];

      // 1. active + no subscription id
      const aRows = (await db.execute(
        sql`SELECT id::text, name, slug, subscription_status
              FROM tenants
             WHERE subscription_status = 'active'
               AND current_plan != 'free'
               AND stripe_subscription_id IS NULL
             LIMIT 50`,
      )) as unknown as Array<{ id: string; name: string; slug: string; subscription_status: string | null }>;
      for (const r of aRows) {
        findings.push({
          kind: "active_no_subscription_id",
          tenantId: r.id,
          tenantName: r.name,
          tenantSlug: r.slug,
          subscriptionStatus: r.subscription_status,
          detail: "Active paid tenant has no stripe_subscription_id on record.",
          severity: "warning",
          suggestedFix: "manual_stripe_sync",
        });
      }

      // 2. past_due + no failed_payment in 30d
      const bRows = (await db.execute(
        sql`SELECT t.id::text, t.name, t.slug, t.subscription_status
              FROM tenants t
             WHERE t.subscription_status = 'past_due'
               AND NOT EXISTS (
                 SELECT 1 FROM billing_transactions b
                  WHERE b.tenant_id = t.id
                    AND b.status = 'failed'
                    AND b.created_at > NOW() - INTERVAL '30 days'
               )
             LIMIT 50`,
      )) as unknown as Array<{ id: string; name: string; slug: string; subscription_status: string | null }>;
      for (const r of bRows) {
        findings.push({
          kind: "past_due_no_failed_payment",
          tenantId: r.id,
          tenantName: r.name,
          tenantSlug: r.slug,
          subscriptionStatus: r.subscription_status,
          detail: "Status=past_due but no failed_payment recorded in last 30 days. Stale flag or manual override.",
          severity: "warning",
          suggestedFix: "manual_stripe_sync",
        });
      }

      // 3. past_due > 30 days + still active
      const cRows = (await db.execute(
        sql`SELECT id::text, name, slug, subscription_status
              FROM tenants
             WHERE subscription_status = 'past_due'
               AND active = true
               AND updated_at < NOW() - INTERVAL '30 days'
             LIMIT 50`,
      )) as unknown as Array<{ id: string; name: string; slug: string; subscription_status: string | null }>;
      for (const r of cRows) {
        findings.push({
          kind: "suspension_overdue",
          tenantId: r.id,
          tenantName: r.name,
          tenantSlug: r.slug,
          subscriptionStatus: r.subscription_status,
          detail: "past_due > 30 days but tenant still active. Suspension automation may have missed this row.",
          severity: "critical",
          suggestedFix: "suspend",
        });
      }

      // 4. trialing + no trial_end
      const dRows = (await db.execute(
        sql`SELECT id::text, name, slug, subscription_status
              FROM tenants
             WHERE subscription_status = 'trialing'
               AND trial_end IS NULL
             LIMIT 50`,
      )) as unknown as Array<{ id: string; name: string; slug: string; subscription_status: string | null }>;
      for (const r of dRows) {
        findings.push({
          kind: "trialing_no_trial_end",
          tenantId: r.id,
          tenantName: r.name,
          tenantSlug: r.slug,
          subscriptionStatus: r.subscription_status,
          detail: "Trial without an end date. Will never auto-expire.",
          severity: "warning",
          suggestedFix: "extend_trial",
        });
      }

      // 5. canceled but still active + still booking
      const eRows = (await db.execute(
        sql`SELECT t.id::text, t.name, t.slug, t.subscription_status
              FROM tenants t
             WHERE t.subscription_status = 'canceled'
               AND t.active = true
               AND EXISTS (
                 SELECT 1 FROM bookings b
                  WHERE b.tenant_id = t.id
                    AND b.created_at > NOW() - INTERVAL '7 days'
               )
             LIMIT 50`,
      )) as unknown as Array<{ id: string; name: string; slug: string; subscription_status: string | null }>;
      for (const r of eRows) {
        findings.push({
          kind: "canceled_still_active",
          tenantId: r.id,
          tenantName: r.name,
          tenantSlug: r.slug,
          subscriptionStatus: r.subscription_status,
          detail: "Marked canceled but tenant booked in last 7 days. Resubscription event likely lost.",
          severity: "warning",
          suggestedFix: "manual_stripe_sync",
        });
      }

      // Sort: critical first.
      const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      findings.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

      return {
        findings,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    120_000,
  );
}
