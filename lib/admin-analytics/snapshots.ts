/**
 * SA-10 — Snapshot read/write helpers.
 *
 * Thin layer over the four snapshot tables. The cron worker
 * (scripts/aggregate-admin-snapshots.ts) calls the upsertDaily*
 * functions; the read APIs surface the latest N rows.
 *
 * Design choices:
 *   • One row per natural key (date / hour / tenant+date / date+plan).
 *     The aggregator upserts on the unique index — re-running the
 *     same period overwrites the previous row.
 *   • Reads never throw — failures degrade to empty arrays. The
 *     dashboards that consume these handle the empty case.
 *   • Retention is enforced from the cron worker, not at the DB
 *     trigger level — simpler operationally and lets ops manually
 *     adjust the window without a DB migration.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

// ─── Daily ─────────────────────────────────────────────────────────

export type DailySnapshot = {
  snapshotDate: string;
  totalTenants: number;
  activeTenants: number;
  payingTenants: number;
  newTenants: number;
  churnedTenants: number;
  totalBookings: number;
  bookingsCompleted: number;
  bookingsNoShow: number;
  totalUsers: number;
  newUsers: number;
  activeUsersDau: number;
  mrrCents: number;
  arrCents: number;
  grossRevenueCents: number;
  refundsCents: number;
  failedCharges: number;
  emailsSent: number;
  emailsFailed: number;
  smsSent: number;
  failedLogins: number;
  adminActions: number;
};

export async function fetchDailySnapshots(days = 90): Promise<DailySnapshot[]> {
  return memoize(
    `admin:snapshots:daily:${days}`,
    async () => {
      const rows = (await db.execute(
        sql`SELECT snapshot_date, total_tenants, active_tenants, paying_tenants,
                   new_tenants, churned_tenants, total_bookings, bookings_completed,
                   bookings_no_show, total_users, new_users, active_users_dau,
                   mrr_cents, arr_cents, gross_revenue_cents, refunds_cents,
                   failed_charges, emails_sent, emails_failed, sms_sent,
                   failed_logins, admin_actions
              FROM analytics_snapshots_daily
             WHERE snapshot_date > NOW() - (${days}::int * INTERVAL '1 day')
             ORDER BY snapshot_date DESC`,
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map(rowToDaily);
    },
    300_000, // 5 min — snapshots only refresh hourly anyway
  );
}

function rowToDaily(r: Record<string, unknown>): DailySnapshot {
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    snapshotDate: String(r.snapshot_date),
    totalTenants: n("total_tenants"),
    activeTenants: n("active_tenants"),
    payingTenants: n("paying_tenants"),
    newTenants: n("new_tenants"),
    churnedTenants: n("churned_tenants"),
    totalBookings: n("total_bookings"),
    bookingsCompleted: n("bookings_completed"),
    bookingsNoShow: n("bookings_no_show"),
    totalUsers: n("total_users"),
    newUsers: n("new_users"),
    activeUsersDau: n("active_users_dau"),
    mrrCents: n("mrr_cents"),
    arrCents: n("arr_cents"),
    grossRevenueCents: n("gross_revenue_cents"),
    refundsCents: n("refunds_cents"),
    failedCharges: n("failed_charges"),
    emailsSent: n("emails_sent"),
    emailsFailed: n("emails_failed"),
    smsSent: n("sms_sent"),
    failedLogins: n("failed_logins"),
    adminActions: n("admin_actions"),
  };
}

export async function upsertDailySnapshot(date: string): Promise<void> {
  // Aggregator runs for a given date (YYYY-MM-DD). Computes the row
  // and upserts on snapshot_date.
  await db.execute(
    sql`INSERT INTO analytics_snapshots_daily (
            snapshot_date,
            total_tenants, active_tenants, paying_tenants, new_tenants, churned_tenants,
            total_bookings, bookings_completed, bookings_no_show,
            total_users, new_users, active_users_dau,
            mrr_cents, arr_cents, gross_revenue_cents, refunds_cents, failed_charges,
            emails_sent, emails_failed, sms_sent,
            failed_logins, admin_actions
          )
          SELECT
            ${date}::date,
            (SELECT COUNT(*)::int FROM tenants),
            (SELECT COUNT(*)::int FROM tenants WHERE active = true),
            (SELECT COUNT(*)::int FROM tenants WHERE active = true AND plan <> 'free'),
            (SELECT COUNT(*)::int FROM tenants WHERE created_at::date = ${date}::date),
            (SELECT COUNT(*)::int FROM audit_logs
              WHERE created_at::date = ${date}::date
                AND (action LIKE '%subscription.cancel%' OR action LIKE 'billing.downgrade%')),
            (SELECT COUNT(*)::int FROM bookings WHERE created_at::date = ${date}::date),
            (SELECT COUNT(*)::int FROM bookings WHERE created_at::date = ${date}::date AND status = 'completed'),
            (SELECT COUNT(*)::int FROM bookings WHERE created_at::date = ${date}::date AND status = 'no_show'),
            (SELECT COUNT(*)::int FROM users),
            (SELECT COUNT(*)::int FROM users WHERE created_at::date = ${date}::date),
            (SELECT COUNT(DISTINCT actor_user_id)::int FROM audit_logs
              WHERE created_at::date = ${date}::date AND actor_user_id IS NOT NULL),
            COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions
                       WHERE status = 'paid' AND created_at::date = ${date}::date), 0),
            COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions
                       WHERE status = 'paid' AND created_at::date = ${date}::date), 0) * 12,
            COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions
                       WHERE status = 'paid' AND created_at::date = ${date}::date), 0),
            COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions
                       WHERE status = 'refunded' AND created_at::date = ${date}::date), 0),
            (SELECT COUNT(*)::int FROM billing_transactions WHERE status = 'failed' AND created_at::date = ${date}::date),
            (SELECT COUNT(*)::int FROM communication_logs WHERE created_at::date = ${date}::date),
            (SELECT COUNT(*)::int FROM communication_logs WHERE status = 'failed' AND created_at::date = ${date}::date),
            (SELECT COUNT(*)::int FROM communication_logs WHERE channel = 'sms' AND created_at::date = ${date}::date),
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'security.authentication.failed%' AND created_at::date = ${date}::date),
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'admin.%' AND created_at::date = ${date}::date)
          ON CONFLICT (snapshot_date) DO UPDATE SET
            total_tenants      = EXCLUDED.total_tenants,
            active_tenants     = EXCLUDED.active_tenants,
            paying_tenants     = EXCLUDED.paying_tenants,
            new_tenants        = EXCLUDED.new_tenants,
            churned_tenants    = EXCLUDED.churned_tenants,
            total_bookings     = EXCLUDED.total_bookings,
            bookings_completed = EXCLUDED.bookings_completed,
            bookings_no_show   = EXCLUDED.bookings_no_show,
            total_users        = EXCLUDED.total_users,
            new_users          = EXCLUDED.new_users,
            active_users_dau   = EXCLUDED.active_users_dau,
            mrr_cents          = EXCLUDED.mrr_cents,
            arr_cents          = EXCLUDED.arr_cents,
            gross_revenue_cents= EXCLUDED.gross_revenue_cents,
            refunds_cents      = EXCLUDED.refunds_cents,
            failed_charges     = EXCLUDED.failed_charges,
            emails_sent        = EXCLUDED.emails_sent,
            emails_failed      = EXCLUDED.emails_failed,
            sms_sent           = EXCLUDED.sms_sent,
            failed_logins      = EXCLUDED.failed_logins,
            admin_actions      = EXCLUDED.admin_actions`,
  );
}

// ─── Hourly ────────────────────────────────────────────────────────

export type HourlySnapshot = {
  snapshotHour: string;
  bookings: number;
  signups: number;
  logins: number;
  failedLogins: number;
  emailsSent: number;
  emailsFailed: number;
  webhookEvents: number;
  webhookFailures: number;
  errorsTotal: number;
};

export async function fetchHourlySnapshots(hours = 168): Promise<HourlySnapshot[]> {
  return memoize(
    `admin:snapshots:hourly:${hours}`,
    async () => {
      const rows = (await db.execute(
        sql`SELECT snapshot_hour, bookings, signups, logins, failed_logins,
                   emails_sent, emails_failed, webhook_events, webhook_failures, errors_total
              FROM analytics_snapshots_hourly
             WHERE snapshot_hour > NOW() - (${hours}::int * INTERVAL '1 hour')
             ORDER BY snapshot_hour DESC`,
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        snapshotHour: String(r.snapshot_hour),
        bookings: Number(r.bookings ?? 0),
        signups: Number(r.signups ?? 0),
        logins: Number(r.logins ?? 0),
        failedLogins: Number(r.failed_logins ?? 0),
        emailsSent: Number(r.emails_sent ?? 0),
        emailsFailed: Number(r.emails_failed ?? 0),
        webhookEvents: Number(r.webhook_events ?? 0),
        webhookFailures: Number(r.webhook_failures ?? 0),
        errorsTotal: Number(r.errors_total ?? 0),
      }));
    },
    60_000,
  );
}

export async function upsertHourlySnapshot(hour: string): Promise<void> {
  // `hour` is an ISO timestamp truncated to the hour.
  await db.execute(
    sql`INSERT INTO analytics_snapshots_hourly (
            snapshot_hour,
            bookings, signups, logins, failed_logins,
            emails_sent, emails_failed,
            webhook_events, webhook_failures, errors_total
          )
          SELECT
            ${hour}::timestamptz,
            (SELECT COUNT(*)::int FROM bookings WHERE date_trunc('hour', created_at) = ${hour}::timestamptz),
            (SELECT COUNT(*)::int FROM tenants WHERE date_trunc('hour', created_at) = ${hour}::timestamptz),
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'security.authentication.success%' AND date_trunc('hour', created_at) = ${hour}::timestamptz),
            (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'security.authentication.failed%' AND date_trunc('hour', created_at) = ${hour}::timestamptz),
            (SELECT COUNT(*)::int FROM communication_logs WHERE date_trunc('hour', created_at) = ${hour}::timestamptz),
            (SELECT COUNT(*)::int FROM communication_logs WHERE status = 'failed' AND date_trunc('hour', created_at) = ${hour}::timestamptz),
            (SELECT COUNT(*)::int FROM audit_logs WHERE action ILIKE '%webhook%' AND date_trunc('hour', created_at) = ${hour}::timestamptz),
            (SELECT COUNT(*)::int FROM audit_logs WHERE action ILIKE '%webhook%' AND (action ILIKE '%fail%' OR action ILIKE '%error%') AND date_trunc('hour', created_at) = ${hour}::timestamptz),
            (SELECT COUNT(*)::int FROM audit_logs WHERE (action ILIKE '%fail%' OR action ILIKE '%error%' OR action ILIKE '%crash%') AND date_trunc('hour', created_at) = ${hour}::timestamptz)
          ON CONFLICT (snapshot_hour) DO UPDATE SET
            bookings         = EXCLUDED.bookings,
            signups          = EXCLUDED.signups,
            logins           = EXCLUDED.logins,
            failed_logins    = EXCLUDED.failed_logins,
            emails_sent      = EXCLUDED.emails_sent,
            emails_failed    = EXCLUDED.emails_failed,
            webhook_events   = EXCLUDED.webhook_events,
            webhook_failures = EXCLUDED.webhook_failures,
            errors_total     = EXCLUDED.errors_total`,
  );
}

// ─── Tenant health ─────────────────────────────────────────────────

export type TenantHealthSnapshot = {
  tenantId: string;
  snapshotDate: string;
  healthScore: number;
  riskLevel: string;
  mrrCents: number;
  bookings30d: number;
  bookingsGrowthPct: number | null;
  failedLogins7d: number;
  failedCharges30d: number;
  lastActivityAt: string | null;
};

export async function fetchTenantHealthSnapshots(args: {
  date?: string;
  limit?: number;
}): Promise<TenantHealthSnapshot[]> {
  const limit = Math.min(Math.max(args.limit ?? 100, 1), 500);
  const date = args.date ?? null;
  const rows = (await db.execute(
    sql`SELECT tenant_id::text, snapshot_date, health_score, risk_level, mrr_cents,
               bookings_30d, bookings_growth_pct, failed_logins_7d, failed_charges_30d, last_activity_at
          FROM tenant_health_snapshots
         WHERE (${date}::text IS NULL OR snapshot_date = ${date}::date)
         ORDER BY snapshot_date DESC, health_score ASC
         LIMIT ${limit}`,
  )) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    tenantId: String(r.tenant_id),
    snapshotDate: String(r.snapshot_date),
    healthScore: Number(r.health_score ?? 0),
    riskLevel: String(r.risk_level ?? "low"),
    mrrCents: Number(r.mrr_cents ?? 0),
    bookings30d: Number(r.bookings_30d ?? 0),
    bookingsGrowthPct: r.bookings_growth_pct === null ? null : Number(r.bookings_growth_pct),
    failedLogins7d: Number(r.failed_logins_7d ?? 0),
    failedCharges30d: Number(r.failed_charges_30d ?? 0),
    lastActivityAt: r.last_activity_at ? String(r.last_activity_at) : null,
  }));
}

export async function upsertTenantHealthSnapshots(date: string): Promise<{ rows: number }> {
  // One pass per tenant. Deterministic risk score: simple heuristic
  // mirroring the scoring layer (lib/admin-analytics/tenant-scoring.ts).
  const tenants = (await db.execute(
    sql`SELECT id::text AS id FROM tenants WHERE active = true`,
  )) as unknown as Array<{ id: string }>;

  for (const t of tenants) {
    await db.execute(
      sql`INSERT INTO tenant_health_snapshots (
              tenant_id, snapshot_date,
              health_score, risk_level,
              mrr_cents, bookings_30d, bookings_growth_pct,
              failed_logins_7d, failed_charges_30d, last_activity_at
            )
            SELECT
              ${t.id}::uuid,
              ${date}::date,
              GREATEST(0, LEAST(100, 100
                - (CASE WHEN failed_charges_30d > 0 THEN 20 ELSE 0 END)
                - (CASE WHEN bookings_30d = 0 THEN 30 ELSE 0 END)
                - (CASE WHEN failed_logins_7d >= 5 THEN 10 ELSE 0 END)
              ))::int AS health_score,
              CASE
                WHEN failed_charges_30d >= 3 OR (bookings_30d = 0 AND last_activity_at < NOW() - INTERVAL '14 days') THEN 'critical'
                WHEN failed_charges_30d >= 1 OR bookings_30d < 3 THEN 'high'
                WHEN bookings_30d < 10 THEN 'medium'
                ELSE 'low'
              END AS risk_level,
              mrr_cents, bookings_30d, bookings_growth_pct,
              failed_logins_7d, failed_charges_30d, last_activity_at
              FROM (
                SELECT
                  COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions
                              WHERE tenant_id = ${t.id}::uuid AND status='paid' AND created_at > NOW() - INTERVAL '30 days'), 0) AS mrr_cents,
                  (SELECT COUNT(*)::int FROM bookings WHERE tenant_id = ${t.id}::uuid AND created_at > NOW() - INTERVAL '30 days') AS bookings_30d,
                  NULL::numeric(8,2) AS bookings_growth_pct,
                  (SELECT COUNT(*)::int FROM audit_logs WHERE tenant_id = ${t.id}::uuid AND action LIKE 'security.authentication.failed%' AND created_at > NOW() - INTERVAL '7 days') AS failed_logins_7d,
                  (SELECT COUNT(*)::int FROM billing_transactions WHERE tenant_id = ${t.id}::uuid AND status='failed' AND created_at > NOW() - INTERVAL '30 days') AS failed_charges_30d,
                  (SELECT MAX(created_at) FROM audit_logs WHERE tenant_id = ${t.id}::uuid) AS last_activity_at
              ) src
            ON CONFLICT (tenant_id, snapshot_date) DO UPDATE SET
              health_score        = EXCLUDED.health_score,
              risk_level          = EXCLUDED.risk_level,
              mrr_cents           = EXCLUDED.mrr_cents,
              bookings_30d        = EXCLUDED.bookings_30d,
              bookings_growth_pct = EXCLUDED.bookings_growth_pct,
              failed_logins_7d    = EXCLUDED.failed_logins_7d,
              failed_charges_30d  = EXCLUDED.failed_charges_30d,
              last_activity_at    = EXCLUDED.last_activity_at`,
    );
  }

  return { rows: tenants.length };
}

// ─── Financial ─────────────────────────────────────────────────────

export type FinancialSnapshot = {
  snapshotDate: string;
  plan: string;
  activeSubscriptions: number;
  newSubscriptions: number;
  cancelledSubscriptions: number;
  mrrCents: number;
  grossRevenueCents: number;
  refundsCents: number;
  netRevenueCents: number;
  failedCharges: number;
  dunningActive: number;
};

export async function fetchFinancialSnapshots(days = 60): Promise<FinancialSnapshot[]> {
  return memoize(
    `admin:snapshots:finance:${days}`,
    async () => {
      const rows = (await db.execute(
        sql`SELECT snapshot_date, plan, active_subscriptions, new_subscriptions,
                   cancelled_subscriptions, mrr_cents, gross_revenue_cents,
                   refunds_cents, net_revenue_cents, failed_charges, dunning_active
              FROM financial_snapshots
             WHERE snapshot_date > NOW() - (${days}::int * INTERVAL '1 day')
             ORDER BY snapshot_date DESC, plan ASC`,
      )) as unknown as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        snapshotDate: String(r.snapshot_date),
        plan: String(r.plan),
        activeSubscriptions: Number(r.active_subscriptions ?? 0),
        newSubscriptions: Number(r.new_subscriptions ?? 0),
        cancelledSubscriptions: Number(r.cancelled_subscriptions ?? 0),
        mrrCents: Number(r.mrr_cents ?? 0),
        grossRevenueCents: Number(r.gross_revenue_cents ?? 0),
        refundsCents: Number(r.refunds_cents ?? 0),
        netRevenueCents: Number(r.net_revenue_cents ?? 0),
        failedCharges: Number(r.failed_charges ?? 0),
        dunningActive: Number(r.dunning_active ?? 0),
      }));
    },
    300_000,
  );
}

export async function upsertFinancialSnapshots(date: string): Promise<{ rows: number }> {
  // One row per (date, plan). Plans are inferred from the live tenants
  // table so we don't depend on a hard-coded enum.
  const plans = (await db.execute(
    sql`SELECT DISTINCT plan FROM tenants WHERE plan IS NOT NULL`,
  )) as unknown as Array<{ plan: string }>;

  for (const p of plans) {
    await db.execute(
      sql`INSERT INTO financial_snapshots (
              snapshot_date, plan,
              active_subscriptions, new_subscriptions, cancelled_subscriptions,
              mrr_cents, gross_revenue_cents, refunds_cents, net_revenue_cents,
              failed_charges, dunning_active
            )
            SELECT
              ${date}::date,
              ${p.plan},
              (SELECT COUNT(*)::int FROM tenants WHERE plan = ${p.plan} AND active = true),
              (SELECT COUNT(*)::int FROM tenants WHERE plan = ${p.plan} AND created_at::date = ${date}::date),
              (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE '%subscription.cancel%' AND created_at::date = ${date}::date
                 AND tenant_id IN (SELECT id FROM tenants WHERE plan = ${p.plan})),
              COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions bt
                         JOIN tenants t ON t.id = bt.tenant_id
                        WHERE t.plan = ${p.plan} AND bt.status = 'paid' AND bt.created_at::date = ${date}::date), 0),
              COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions bt
                         JOIN tenants t ON t.id = bt.tenant_id
                        WHERE t.plan = ${p.plan} AND bt.status = 'paid' AND bt.created_at::date = ${date}::date), 0),
              COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions bt
                         JOIN tenants t ON t.id = bt.tenant_id
                        WHERE t.plan = ${p.plan} AND bt.status = 'refunded' AND bt.created_at::date = ${date}::date), 0),
              COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions bt
                         JOIN tenants t ON t.id = bt.tenant_id
                        WHERE t.plan = ${p.plan} AND bt.status = 'paid' AND bt.created_at::date = ${date}::date), 0) -
              COALESCE((SELECT SUM(amount_cents)::bigint FROM billing_transactions bt
                         JOIN tenants t ON t.id = bt.tenant_id
                        WHERE t.plan = ${p.plan} AND bt.status = 'refunded' AND bt.created_at::date = ${date}::date), 0),
              (SELECT COUNT(*)::int FROM billing_transactions bt
                 JOIN tenants t ON t.id = bt.tenant_id
                WHERE t.plan = ${p.plan} AND bt.status = 'failed' AND bt.created_at::date = ${date}::date),
              (SELECT COUNT(DISTINCT bt.tenant_id)::int FROM billing_transactions bt
                 JOIN tenants t ON t.id = bt.tenant_id
                WHERE t.plan = ${p.plan} AND bt.status = 'failed' AND bt.created_at > NOW() - INTERVAL '7 days')
          ON CONFLICT (snapshot_date, plan) DO UPDATE SET
            active_subscriptions    = EXCLUDED.active_subscriptions,
            new_subscriptions       = EXCLUDED.new_subscriptions,
            cancelled_subscriptions = EXCLUDED.cancelled_subscriptions,
            mrr_cents               = EXCLUDED.mrr_cents,
            gross_revenue_cents     = EXCLUDED.gross_revenue_cents,
            refunds_cents           = EXCLUDED.refunds_cents,
            net_revenue_cents       = EXCLUDED.net_revenue_cents,
            failed_charges          = EXCLUDED.failed_charges,
            dunning_active          = EXCLUDED.dunning_active`,
    );
  }
  return { rows: plans.length };
}

// ─── Retention ─────────────────────────────────────────────────────

export async function applyRetention(): Promise<{
  daily: number;
  hourly: number;
  tenantHealth: number;
  financial: number;
}> {
  const daily = (await db.execute(
    sql`DELETE FROM analytics_snapshots_daily WHERE snapshot_date < NOW() - INTERVAL '730 days' RETURNING id`,
  )) as unknown as Array<unknown>;
  const hourly = (await db.execute(
    sql`DELETE FROM analytics_snapshots_hourly WHERE snapshot_hour < NOW() - INTERVAL '90 days' RETURNING id`,
  )) as unknown as Array<unknown>;
  const tenantHealth = (await db.execute(
    sql`DELETE FROM tenant_health_snapshots WHERE snapshot_date < NOW() - INTERVAL '365 days' RETURNING id`,
  )) as unknown as Array<unknown>;
  const financial = (await db.execute(
    sql`DELETE FROM financial_snapshots WHERE snapshot_date < NOW() - INTERVAL '730 days' RETURNING id`,
  )) as unknown as Array<unknown>;
  return {
    daily: daily.length,
    hourly: hourly.length,
    tenantHealth: tenantHealth.length,
    financial: financial.length,
  };
}
