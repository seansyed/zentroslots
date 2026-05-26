/**
 * Revenue analytics — time series + distributions for SA-2 charts.
 *
 * Six pure DB functions that feed the Recharts visualizations on
 * /admin/revenue. Each function is wrapped in safe() so a single
 * query failure becomes a categorical `error` field rather than
 * a global throw — preserves the per-section error isolation
 * invariant from SA-1.
 *
 * Data sources:
 *   • tenants               (current state: plan, status, createdAt)
 *   • plans                 (price catalog)
 *   • billing_transactions  (paid charges + refunds, NOT subscription
 *                            state changes — that's audit_logs)
 *   • audit_logs            (billing.* actions for churn/upgrade events)
 *   • bookings              (volume signal for revenue context)
 *
 * All metrics CROSS-TENANT (no tenantId filter). Super-admin only.
 *
 * NO MOCK DATA: every value comes from the DB. Series are empty when
 * the underlying data is empty (fresh deploy) and charts handle that
 * gracefully with EmptyState renderers.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

// ─── Public types ──────────────────────────────────────────────────

export type MonthPoint = { month: string; value: number };
export type DualPoint = { month: string; a: number; b: number };
export type PlanSlice = { plan: string; tenants: number; mrrCents: number };
export type TopTenant = { tenantId: string; name: string; mrrCents: number };

export type RevenueSeries = {
  /** Sum of succeeded billing_transactions per month, last 12 months. */
  monthlyRevenue: MonthPoint[];
  /** Snapshot ARR (MRR × 12). Single scalar — no historical series
   *  (we'd need an MRR daily-snapshot table). Surfaced as 1-point
   *  series for chart consistency. */
  arrSnapshotCents: number;
  /** Net new tenant signups per month, last 12 months. */
  signupsByMonth: MonthPoint[];
  /** Plan distribution (current snapshot). */
  planDistribution: PlanSlice[];
  /** Churn vs upgrades by month. a = churns, b = upgrades, last 12 months. */
  churnVsUpgrades: DualPoint[];
  /** Bookings per month last 12 months (revenue-context signal). */
  bookingsByMonth: MonthPoint[];
  /** Top revenue-generating tenants right now (current MRR). */
  topTenantsByMrr: TopTenant[];
  /** Per-section errors, if any. */
  errors: Record<string, string>;
  computedInMs: number;
};

// ─── Helpers ───────────────────────────────────────────────────────

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function lastNMonthKeys(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    out.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  return out;
}

function fillMonths(rows: Array<{ m: string; n: number | string | null }>, n: number): MonthPoint[] {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.m, Number(r.n) || 0);
  return lastNMonthKeys(n).map((k) => ({ month: k, value: map.get(k) ?? 0 }));
}

// ─── 1. Monthly revenue (last 12 months) ───────────────────────────

async function computeMonthlyRevenue(): Promise<{ data: MonthPoint[]; err?: string }> {
  try {
    const rows = (await db.execute(
      sql`SELECT to_char(date_trunc('month', COALESCE(paid_at, created_at)), 'YYYY-MM') AS m,
                 SUM(CASE WHEN transaction_type = 'refund' THEN -amount_cents ELSE amount_cents END)::bigint AS n
            FROM billing_transactions
           WHERE status = 'succeeded'
             AND COALESCE(paid_at, created_at) >= NOW() - INTERVAL '12 months'
           GROUP BY 1
           ORDER BY 1`,
    )) as unknown as Array<{ m: string; n: number | string | null }>;
    return { data: fillMonths(rows, 12) };
  } catch (err) {
    return { data: [], err: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

// ─── 2. ARR snapshot (MRR × 12) ────────────────────────────────────

async function computeArrSnapshot(): Promise<{ value: number; err?: string }> {
  try {
    // Reuse the same SQL pattern as the MRR KPI.
    const rows = (await db.execute(
      sql`SELECT COALESCE(SUM(p.price_monthly_cents)::bigint, 0) AS mrr
            FROM tenants t
            JOIN plans p ON p.slug = t.current_plan
           WHERE t.active = true
             AND t.subscription_status = 'active'`,
    )) as unknown as Array<{ mrr: number | string | null }>;
    const mrr = Number(rows[0]?.mrr ?? 0);
    return { value: mrr * 12 };
  } catch (err) {
    return { value: 0, err: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

// ─── 3. Signups by month ───────────────────────────────────────────

async function computeSignupsByMonth(): Promise<{ data: MonthPoint[]; err?: string }> {
  try {
    const rows = (await db.execute(
      sql`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m,
                 COUNT(*)::int AS n
            FROM tenants
           WHERE created_at >= NOW() - INTERVAL '12 months'
           GROUP BY 1
           ORDER BY 1`,
    )) as unknown as Array<{ m: string; n: number | string | null }>;
    return { data: fillMonths(rows, 12) };
  } catch (err) {
    return { data: [], err: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

// ─── 4. Plan distribution ─────────────────────────────────────────

async function computePlanDistribution(): Promise<{ data: PlanSlice[]; err?: string }> {
  try {
    const rows = (await db.execute(
      sql`SELECT t.current_plan AS plan,
                 COUNT(*)::int AS tenants,
                 COALESCE(MAX(p.price_monthly_cents)::bigint, 0) AS price_cents
            FROM tenants t
            LEFT JOIN plans p ON p.slug = t.current_plan
           WHERE t.active = true
             AND t.subscription_status = 'active'
           GROUP BY t.current_plan
           ORDER BY COUNT(*) DESC`,
    )) as unknown as Array<{ plan: string; tenants: number | string | null; price_cents: number | string | null }>;
    return {
      data: rows.map((r) => ({
        plan: r.plan ?? "unknown",
        tenants: Number(r.tenants ?? 0),
        mrrCents: Number(r.tenants ?? 0) * Number(r.price_cents ?? 0),
      })),
    };
  } catch (err) {
    return { data: [], err: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

// ─── 5. Churn vs Upgrades ─────────────────────────────────────────

async function computeChurnVsUpgrades(): Promise<{ data: DualPoint[]; err?: string }> {
  try {
    // Churn = audit_logs action LIKE 'billing.downgrade_applied%' OR
    //          'subscription.canceled' — these are the canonical
    //          cancellation/downgrade audit events.
    // Upgrade = audit_logs action LIKE 'billing.upgrade_applied%' OR
    //            'subscription.upgraded'.
    const rows = (await db.execute(
      sql`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m,
                 SUM(CASE WHEN action LIKE 'billing.downgrade%' OR action LIKE 'subscription.cancel%' THEN 1 ELSE 0 END)::int AS churns,
                 SUM(CASE WHEN action LIKE 'billing.upgrade%' OR action LIKE 'subscription.upgrade%' OR action LIKE 'billing.plan_transition%' THEN 1 ELSE 0 END)::int AS upgrades
            FROM audit_logs
           WHERE created_at >= NOW() - INTERVAL '12 months'
             AND (action LIKE 'billing.%' OR action LIKE 'subscription.%')
           GROUP BY 1
           ORDER BY 1`,
    )) as unknown as Array<{ m: string; churns: number | string | null; upgrades: number | string | null }>;
    const map = new Map(rows.map((r) => [r.m, { c: Number(r.churns) || 0, u: Number(r.upgrades) || 0 }]));
    return {
      data: lastNMonthKeys(12).map((k) => ({
        month: k,
        a: map.get(k)?.c ?? 0,
        b: map.get(k)?.u ?? 0,
      })),
    };
  } catch (err) {
    return { data: [], err: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

// ─── 6. Bookings by month ─────────────────────────────────────────

async function computeBookingsByMonth(): Promise<{ data: MonthPoint[]; err?: string }> {
  try {
    const rows = (await db.execute(
      sql`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m,
                 COUNT(*)::int AS n
            FROM bookings
           WHERE created_at >= NOW() - INTERVAL '12 months'
           GROUP BY 1
           ORDER BY 1`,
    )) as unknown as Array<{ m: string; n: number | string | null }>;
    return { data: fillMonths(rows, 12) };
  } catch (err) {
    return { data: [], err: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

// ─── 7. Top tenants by MRR ─────────────────────────────────────────

async function computeTopTenantsByMrr(): Promise<{ data: TopTenant[]; err?: string }> {
  try {
    const rows = (await db.execute(
      sql`SELECT t.id, t.name,
                 COALESCE(p.price_monthly_cents, 0)::bigint AS mrr_cents
            FROM tenants t
            LEFT JOIN plans p ON p.slug = t.current_plan
           WHERE t.active = true
             AND t.subscription_status = 'active'
           ORDER BY mrr_cents DESC, t.name ASC
           LIMIT 10`,
    )) as unknown as Array<{ id: string; name: string; mrr_cents: number | string | null }>;
    return {
      data: rows.map((r) => ({
        tenantId: r.id,
        name: r.name,
        mrrCents: Number(r.mrr_cents ?? 0),
      })),
    };
  } catch (err) {
    return { data: [], err: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────

export async function computeRevenueSeries(): Promise<RevenueSeries> {
  return memoize(
    "admin:revenue:v1",
    async () => {
      const t0 = Date.now();
      const [revenue, arr, signups, plans, churn, bookings, topTenants] = await Promise.all([
        computeMonthlyRevenue(),
        computeArrSnapshot(),
        computeSignupsByMonth(),
        computePlanDistribution(),
        computeChurnVsUpgrades(),
        computeBookingsByMonth(),
        computeTopTenantsByMrr(),
      ]);
      const errors: Record<string, string> = {};
      if (revenue.err) errors.monthlyRevenue = revenue.err;
      if (arr.err) errors.arrSnapshot = arr.err;
      if (signups.err) errors.signups = signups.err;
      if (plans.err) errors.planDistribution = plans.err;
      if (churn.err) errors.churnVsUpgrades = churn.err;
      if (bookings.err) errors.bookings = bookings.err;
      if (topTenants.err) errors.topTenants = topTenants.err;
      return {
        monthlyRevenue: revenue.data,
        arrSnapshotCents: arr.value,
        signupsByMonth: signups.data,
        planDistribution: plans.data,
        churnVsUpgrades: churn.data,
        bookingsByMonth: bookings.data,
        topTenantsByMrr: topTenants.data,
        errors,
        computedInMs: Date.now() - t0,
      };
    },
    180_000, // 3 min — revenue charts are slow-moving
  );
}
