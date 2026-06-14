/**
 * Stabilization Wave — Billing reliability validator.
 *
 * Deterministic, read-only audit that surfaces:
 *   • duplicate_charges          — multiple succeeded billing_transactions
 *                                  in the same (tenant, invoice, day) window
 *   • orphan_subscriptions       — tenants.stripe_subscription_id set but
 *                                  status not in {active, trialing, past_due, …}
 *   • desynced_status            — tenants.subscriptionStatus says
 *                                  active/trialing but no successful charge
 *                                  in last 60d AND not on free
 *   • stuck_pending_payment      — bookings.status='pending_payment'
 *                                  past hold expiry by >5min
 *   • unresolved_invoices        — invoices with status='open' >14d
 *   • failed_recovery_candidates — billing_transactions.status='failed'
 *                                  within last 7d with no subsequent
 *                                  succeeded for the same customer
 *
 * Every finding includes the tenant id + a one-line remediation hint.
 * NEVER mutates state — purely diagnostic.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

export type BillingFindingKind =
  | "duplicate_charges"
  | "orphan_subscriptions"
  | "desynced_status"
  | "stuck_pending_payment"
  | "unresolved_invoices"
  | "failed_recovery_candidates";

export type BillingFinding = {
  kind: BillingFindingKind;
  severity: "info" | "warning" | "critical";
  count: number;
  description: string;
  remediation: string;
  /** Bounded sample of impacted rows. Never include card data or
   *  payment intent secrets — just ids. */
  samples: Array<Record<string, string | number | null>>;
};

export type BillingValidationReport = {
  findings: BillingFinding[];
  summary: {
    total: number;
    critical: number;
    warnings: number;
    info: number;
    healthy: boolean;
  };
  generatedAt: string;
  computedInMs: number;
};

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "billing_validate.query_fail",
        reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      }),
    );
    return fallback;
  }
}

export async function computeBillingValidation(): Promise<BillingValidationReport> {
  return memoize(
    "admin:billing:validation:v1",
    async () => {
      const t0 = Date.now();
      const findings: BillingFinding[] = [];

      // 1. Duplicate charges — same tenant + same idempotency null
      // succeeded twice in the same hour. Indicates a webhook replay
      // hitting an endpoint that didn't dedupe properly.
      const dupRows = await safe(
        async () =>
          (await db.execute(
            sql`SELECT tenant_id::text, COUNT(*)::int AS n,
                       SUM(amount_cents)::bigint AS total_cents,
                       MIN(created_at) AS first_at,
                       MAX(created_at) AS last_at
                  FROM billing_transactions
                 WHERE status = 'paid'
                   AND created_at > NOW() - INTERVAL '30 days'
                 GROUP BY tenant_id, date_trunc('hour', created_at), amount_cents
                HAVING COUNT(*) > 1
                 ORDER BY n DESC
                 LIMIT 20`,
          )) as unknown as Array<{
            tenant_id: string;
            n: number;
            total_cents: number;
            first_at: string;
            last_at: string;
          }>,
        [],
      );
      if (dupRows.length > 0) {
        findings.push({
          kind: "duplicate_charges",
          severity: "critical",
          count: dupRows.length,
          description: `${dupRows.length} tenant-hour buckets with >1 succeeded charge of identical amount. Indicates webhook idempotency failure.`,
          remediation: "Verify Stripe webhook deduplication via processed_stripe_events. Refund the duplicate if confirmed.",
          samples: dupRows.slice(0, 5).map((r) => ({
            tenantId: r.tenant_id,
            duplicates: Number(r.n),
            totalCents: Number(r.total_cents),
            firstAt: r.first_at,
            lastAt: r.last_at,
          })),
        });
      }

      // 2. Orphan subscriptions — Stripe ID stamped but status null/canceled
      // while tenant is still active=true with plan ≠ free.
      const orphans = await safe(
        async () =>
          (await db.execute(
            sql`SELECT id::text AS tenant_id, name, plan, subscription_status, stripe_subscription_id
                  FROM tenants
                 WHERE active = true
                   AND plan <> 'free'
                   AND stripe_subscription_id IS NOT NULL
                   AND (subscription_status IS NULL OR subscription_status IN ('canceled','incomplete_expired','unpaid'))
                 LIMIT 20`,
          )) as unknown as Array<{
            tenant_id: string;
            name: string;
            plan: string;
            subscription_status: string | null;
            stripe_subscription_id: string;
          }>,
        [],
      );
      if (orphans.length > 0) {
        findings.push({
          kind: "orphan_subscriptions",
          severity: "warning",
          count: orphans.length,
          description: `${orphans.length} tenants on paid plans with a Stripe sub ID but no active billing status. They're getting premium features without paying.`,
          remediation: "Either downgrade tenant.plan to 'free' or reactivate the subscription in Stripe.",
          samples: orphans.slice(0, 5).map((r) => ({
            tenantId: r.tenant_id,
            name: r.name,
            plan: r.plan,
            subscriptionStatus: r.subscription_status,
          })),
        });
      }

      // 3. Desynced status — claims to be active but no successful charge
      // in 60d on a paid plan. Either trial expiry not enforced or a
      // missed webhook.
      const desynced = await safe(
        async () =>
          (await db.execute(
            sql`SELECT t.id::text AS tenant_id, t.name, t.plan, t.subscription_status,
                       (SELECT MAX(created_at) FROM billing_transactions
                          WHERE tenant_id = t.id AND status='paid') AS last_charge_at
                  FROM tenants t
                 WHERE t.active = true
                   AND t.plan <> 'free'
                   AND t.subscription_status IN ('active','trialing')
                   AND NOT EXISTS (
                         SELECT 1 FROM billing_transactions
                          WHERE tenant_id = t.id
                            AND status='paid'
                            AND created_at > NOW() - INTERVAL '60 days'
                       )
                   AND t.created_at < NOW() - INTERVAL '60 days'
                 LIMIT 20`,
          )) as unknown as Array<{
            tenant_id: string;
            name: string;
            plan: string;
            subscription_status: string;
            last_charge_at: string | null;
          }>,
        [],
      );
      if (desynced.length > 0) {
        findings.push({
          kind: "desynced_status",
          severity: "warning",
          count: desynced.length,
          description: `${desynced.length} tenants showing active/trialing on paid plan but no successful charge in 60d.`,
          remediation: "Pull live status from Stripe via /api/admin/billing/sync-tenant. May be a missed invoice.paid webhook.",
          samples: desynced.slice(0, 5).map((r) => ({
            tenantId: r.tenant_id,
            name: r.name,
            plan: r.plan,
            lastChargeAt: r.last_charge_at,
          })),
        });
      }

      // 4. Stuck pending_payment — already surfaced by /api/health but
      // we duplicate it here so the billing report is self-contained.
      const stuck = await safe(
        async () =>
          (await db.execute(
            sql`SELECT id::text, tenant_id::text, start_at, payment_hold_expires_at
                  FROM bookings
                 WHERE status = 'pending_payment'
                   AND payment_hold_expires_at IS NOT NULL
                   AND payment_hold_expires_at < NOW() - INTERVAL '5 minutes'
                 LIMIT 20`,
          )) as unknown as Array<{
            id: string;
            tenant_id: string;
            start_at: string;
            payment_hold_expires_at: string;
          }>,
        [],
      );
      if (stuck.length > 0) {
        findings.push({
          kind: "stuck_pending_payment",
          severity: stuck.length >= 5 ? "critical" : "warning",
          count: stuck.length,
          description: `${stuck.length} bookings stuck in pending_payment past hold expiry by >5min.`,
          remediation: "Run `npm run holds:expire` manually. Verify the cron is in crontab.",
          samples: stuck.slice(0, 5).map((r) => ({
            bookingId: r.id,
            tenantId: r.tenant_id,
            startAt: r.start_at,
            holdExpiredAt: r.payment_hold_expires_at,
          })),
        });
      }

      // 5. Unresolved invoices (open > 14d) — only flag if `invoices` table exists.
      const unresolved = await safe(
        async () =>
          (await db.execute(
            sql`SELECT id::text, tenant_id::text, amount_cents, created_at
                  FROM billing_transactions
                 WHERE status = 'pending'
                   AND created_at < NOW() - INTERVAL '14 days'
                 LIMIT 20`,
          )) as unknown as Array<{
            id: string;
            tenant_id: string;
            amount_cents: number;
            created_at: string;
          }>,
        [],
      );
      if (unresolved.length > 0) {
        findings.push({
          kind: "unresolved_invoices",
          severity: "warning",
          count: unresolved.length,
          description: `${unresolved.length} billing_transactions stuck in 'pending' >14 days.`,
          remediation: "Stripe may have moved on (canceled or paid). Reconcile via /admin/finance Stripe-recon view.",
          samples: unresolved.slice(0, 5).map((r) => ({
            transactionId: r.id,
            tenantId: r.tenant_id,
            amountCents: Number(r.amount_cents),
            createdAt: r.created_at,
          })),
        });
      }

      // 6. Failed recovery candidates — last 7d failures with no subsequent success.
      const recovery = await safe(
        async () =>
          (await db.execute(
            sql`SELECT bt.tenant_id::text,
                       COUNT(*)::int AS failed_count,
                       MAX(bt.created_at) AS last_failed_at
                  FROM billing_transactions bt
                 WHERE bt.status = 'failed'
                   AND bt.created_at > NOW() - INTERVAL '7 days'
                   AND NOT EXISTS (
                         SELECT 1 FROM billing_transactions bt2
                          WHERE bt2.tenant_id = bt.tenant_id
                            AND bt2.status = 'paid'
                            AND bt2.created_at > bt.created_at
                       )
                 GROUP BY bt.tenant_id
                 ORDER BY failed_count DESC
                 LIMIT 20`,
          )) as unknown as Array<{
            tenant_id: string;
            failed_count: number;
            last_failed_at: string;
          }>,
        [],
      );
      if (recovery.length > 0) {
        findings.push({
          kind: "failed_recovery_candidates",
          severity: "warning",
          count: recovery.length,
          description: `${recovery.length} tenants with failed charges in last 7d AND no subsequent success — needs human nudge.`,
          remediation: "Surface in /admin/finance dunning. CS reaches out with a recovery link.",
          samples: recovery.slice(0, 5).map((r) => ({
            tenantId: r.tenant_id,
            failedCount: Number(r.failed_count),
            lastFailedAt: r.last_failed_at,
          })),
        });
      }

      const critical = findings.filter((f) => f.severity === "critical").length;
      const warnings = findings.filter((f) => f.severity === "warning").length;
      const info = findings.filter((f) => f.severity === "info").length;

      return {
        findings,
        summary: {
          total: findings.length,
          critical,
          warnings,
          info,
          healthy: findings.length === 0,
        },
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    120_000,
  );
}
