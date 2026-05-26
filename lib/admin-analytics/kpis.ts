/**
 * Super-admin platform-wide KPI computation.
 *
 * SCOPE: cross-tenant. All metrics aggregate across the entire SaaS
 * — no tenantId filtering. Only super-admin routes call into this.
 *
 * STRUCTURE:
 *   • Each KPI is computed by its own pure async function so a
 *     failure in one never blocks the others.
 *   • computeAllKpis() runs them in parallel via Promise.allSettled
 *     and folds failures into a categorical `error` field per KPI
 *     rather than throwing globally — preserves the dashboard's
 *     "every section loads independently" invariant.
 *   • Numbers are returned as `null` for "data not available yet"
 *     (e.g. zero tenants → can't compute ARPT) so the UI can show
 *     an explicit "—" instead of zero.
 *
 * NO MOCK DATA. Every value flows from a real DB query. Empty-state
 * is honest: a freshly-deployed instance shows zeros / nulls until
 * real tenants exist.
 *
 * Sparklines: a small daily-bucket array (last N days) computed in
 * one grouped query per applicable metric. Charts that need real
 * time series (MRR over time, ARR projection) live in a separate
 * module — kpis.ts only ships the inline mini-sparkline data.
 */

import { and, count, desc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  auditLogs,
  billingTransactions,
  bookings,
  emailSuppressions,
  plans,
  tenants,
  users,
} from "@/db/schema";
import { memoize } from "./cache";

// ─── Public types ──────────────────────────────────────────────────

export type KpiResult = {
  /** The current metric value. Null when not computable
   *  (e.g. denominator is zero). */
  value: number | null;
  /** Previous-period comparison value, where applicable. Null = no
   *  previous comparison was attempted. */
  previousValue: number | null;
  /** Trend delta as a percentage (positive = up). Null when no
   *  comparison is meaningful. */
  deltaPct: number | null;
  /** Daily mini-sparkline. Empty array = no series for this KPI. */
  sparkline: number[];
  /** Display unit hint for the UI: 'currency_cents' | 'count' |
   *  'percent' | 'minutes'. Drives formatting. */
  unit: "currency_cents" | "count" | "percent" | "string";
  /** Optional display label for `string`-unit KPIs (e.g. tenant name). */
  label?: string;
  /** Categorized failure if this KPI couldn't be computed. The whole
   *  rest of the dashboard renders fine even when this is non-null. */
  error?: string;
};

export type KpiBundle = {
  totalMrr: KpiResult;
  arrProjection: KpiResult;
  activePaidTenants: KpiResult;
  trialingTenants: KpiResult;
  churnedThisMonth: KpiResult;
  failedPayments30d: KpiResult;
  newSignups7d: KpiResult;
  newSignups30d: KpiResult;
  totalBookings: KpiResult;
  bookingGrowthPct: KpiResult;
  totalActiveUsers: KpiResult;
  avgBookingsPerTenant: KpiResult;
  trialConversionPct: KpiResult;
  avgRevenuePerTenant: KpiResult;
  highestGrowthTenant: KpiResult;
  emailDeliverySuccessPct: KpiResult;
  calendarSyncHealthPct: KpiResult;
  /** Wall-clock ms the whole bundle took to compute (DB only). */
  computedInMs: number;
};

// ─── Helpers ───────────────────────────────────────────────────────

const empty = (): KpiResult => ({
  value: null,
  previousValue: null,
  deltaPct: null,
  sparkline: [],
  unit: "count",
});

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function pct(curr: number | null, prev: number | null): number | null {
  if (curr === null || prev === null || prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10; // 1 decimal
}

/** Wrap a producer so any error becomes a categorical `error` field
 *  rather than a thrown exception. Preserves dashboard partial-load
 *  invariant. */
async function safe<T extends KpiResult>(producer: () => Promise<T>): Promise<T> {
  try {
    return await producer();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    try {
      console.error(
        JSON.stringify({
          evt: "kpi_fail",
          ts: new Date().toISOString(),
          reason: message.slice(0, 200),
        }),
      );
    } catch {}
    return {
      ...(empty() as unknown as T),
      error: message.slice(0, 200),
    };
  }
}

// ─── Time windows ──────────────────────────────────────────────────

function days(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60_000);
}

function startOfMonth(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function startOfPrevMonth(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth() - 1, 1);
}

// ─── 1. Total MRR ──────────────────────────────────────────────────

async function computeMrr(): Promise<KpiResult> {
  return safe(async () => {
    // MRR = sum over (plan × active-tenant-count) using the plan
    // catalog's priceMonthlyCents. Trialing / past_due / canceled
    // are NOT included — those don't bill until they convert.
    const [priceRows, statusRows] = await Promise.all([
      db.select({ slug: plans.slug, price: plans.priceMonthlyCents }).from(plans),
      db
        .select({
          plan: tenants.currentPlan,
          status: tenants.subscriptionStatus,
          n: sql<number>`COUNT(*)::int`,
        })
        .from(tenants)
        .where(eq(tenants.active, true))
        .groupBy(tenants.currentPlan, tenants.subscriptionStatus),
    ]);
    const priceBy = new Map(priceRows.map((p) => [p.slug, num(p.price)]));
    const mrrCents = statusRows.reduce((sum, r) => {
      if (r.status !== "active") return sum;
      const p = priceBy.get(r.plan ?? "") ?? 0;
      return sum + p * num(r.n);
    }, 0);
    return {
      value: mrrCents,
      previousValue: null,
      deltaPct: null,
      sparkline: [],
      unit: "currency_cents",
    };
  });
}

// ─── 2. ARR Projection ─────────────────────────────────────────────

async function computeArr(mrr: KpiResult): Promise<KpiResult> {
  return {
    value: mrr.value === null ? null : mrr.value * 12,
    previousValue: null,
    deltaPct: null,
    sparkline: [],
    unit: "currency_cents",
  };
}

// ─── 3. Active Paid Tenants ────────────────────────────────────────

async function computeActivePaid(): Promise<KpiResult> {
  return safe(async () => {
    const [currRows, prevRows] = await Promise.all([
      db
        .select({ n: count() })
        .from(tenants)
        .where(
          and(
            eq(tenants.active, true),
            eq(tenants.subscriptionStatus, "active"),
            ne(tenants.currentPlan, "free"),
          ),
        ),
      // Previous-period proxy: tenants currently active + paid that
      // existed > 30 days ago (likely paying last month).
      db
        .select({ n: count() })
        .from(tenants)
        .where(
          and(
            eq(tenants.active, true),
            eq(tenants.subscriptionStatus, "active"),
            ne(tenants.currentPlan, "free"),
            lt(tenants.createdAt, days(30)),
          ),
        ),
    ]);
    const v = num(currRows[0]?.n);
    const p = num(prevRows[0]?.n);
    return {
      value: v,
      previousValue: p,
      deltaPct: pct(v, p),
      sparkline: [],
      unit: "count",
    };
  });
}

// ─── 4. Trialing Tenants ───────────────────────────────────────────

async function computeTrialing(): Promise<KpiResult> {
  return safe(async () => {
    const rows = await db
      .select({ n: count() })
      .from(tenants)
      .where(and(eq(tenants.active, true), eq(tenants.subscriptionStatus, "trialing")));
    return { ...empty(), value: num(rows[0]?.n) };
  });
}

// ─── 5. Churned This Month ─────────────────────────────────────────

async function computeChurned(): Promise<KpiResult> {
  return safe(async () => {
    // "Churned" = subscriptionStatus = canceled with updatedAt in the
    // current calendar month. We use audit_logs for billing.* events
    // as a fallback signal — but the canonical signal is tenant
    // status flips through customer.subscription.deleted webhook.
    const startCurr = startOfMonth();
    const startPrev = startOfPrevMonth();
    const [currRows, prevRows] = await Promise.all([
      db
        .select({ n: count() })
        .from(tenants)
        .where(
          and(
            eq(tenants.subscriptionStatus, "canceled"),
            gte(tenants.updatedAt, startCurr),
          ),
        ),
      db
        .select({ n: count() })
        .from(tenants)
        .where(
          and(
            eq(tenants.subscriptionStatus, "canceled"),
            gte(tenants.updatedAt, startPrev),
            lt(tenants.updatedAt, startCurr),
          ),
        ),
    ]);
    const v = num(currRows[0]?.n);
    const p = num(prevRows[0]?.n);
    return {
      value: v,
      previousValue: p,
      deltaPct: pct(v, p),
      sparkline: [],
      unit: "count",
    };
  });
}

// ─── 6. Failed Payments (30d) ──────────────────────────────────────

async function computeFailedPayments(): Promise<KpiResult> {
  return safe(async () => {
    // billing_transactions schema has an event_type column carrying
    // the Stripe event type. Failures live under
    // `payment_intent.payment_failed` and `invoice.payment_failed`.
    // We OR both via SQL like.
    const [currRow, prevRow] = await Promise.all([
      db.execute(
        sql`SELECT COUNT(*)::int AS n
              FROM billing_transactions
             WHERE event_type LIKE '%payment_failed%'
               AND created_at >= NOW() - INTERVAL '30 days'`,
      ),
      db.execute(
        sql`SELECT COUNT(*)::int AS n
              FROM billing_transactions
             WHERE event_type LIKE '%payment_failed%'
               AND created_at >= NOW() - INTERVAL '60 days'
               AND created_at <  NOW() - INTERVAL '30 days'`,
      ),
    ]);
    const v = num((currRow as unknown as Array<{ n: number }>)[0]?.n);
    const p = num((prevRow as unknown as Array<{ n: number }>)[0]?.n);
    return {
      value: v,
      previousValue: p,
      deltaPct: pct(v, p),
      sparkline: [],
      unit: "count",
    };
  });
}

// ─── 7. New Signups (7d, 30d) ──────────────────────────────────────

async function computeSignups(window: 7 | 30): Promise<KpiResult> {
  return safe(async () => {
    const [currRows, prevRows] = await Promise.all([
      db.select({ n: count() }).from(tenants).where(gte(tenants.createdAt, days(window))),
      db
        .select({ n: count() })
        .from(tenants)
        .where(
          and(
            gte(tenants.createdAt, days(window * 2)),
            lt(tenants.createdAt, days(window)),
          ),
        ),
    ]);
    const v = num(currRows[0]?.n);
    const p = num(prevRows[0]?.n);
    return {
      value: v,
      previousValue: p,
      deltaPct: pct(v, p),
      sparkline: [],
      unit: "count",
    };
  });
}

// ─── 8. Total Bookings ─────────────────────────────────────────────

async function computeTotalBookings(): Promise<KpiResult> {
  return safe(async () => {
    const rows = await db.select({ n: count() }).from(bookings);
    return { ...empty(), value: num(rows[0]?.n) };
  });
}

// ─── 9. Booking Growth (30d current vs prior 30d) ──────────────────

async function computeBookingGrowth(): Promise<KpiResult> {
  return safe(async () => {
    const [currRows, prevRows] = await Promise.all([
      db.select({ n: count() }).from(bookings).where(gte(bookings.createdAt, days(30))),
      db
        .select({ n: count() })
        .from(bookings)
        .where(and(gte(bookings.createdAt, days(60)), lt(bookings.createdAt, days(30)))),
    ]);
    const v = num(currRows[0]?.n);
    const p = num(prevRows[0]?.n);
    // Sparkline: daily counts for the last 14 days. One grouped query.
    const sparkRows = (await db.execute(
      sql`SELECT date_trunc('day', created_at) AS d, COUNT(*)::int AS n
            FROM bookings
           WHERE created_at >= NOW() - INTERVAL '14 days'
           GROUP BY 1
           ORDER BY 1`,
    )) as unknown as Array<{ d: string; n: number }>;
    return {
      value: v,
      previousValue: p,
      deltaPct: pct(v, p),
      sparkline: sparkRows.map((r) => num(r.n)),
      unit: "count",
    };
  });
}

// ─── 10. Total Active Users ────────────────────────────────────────

async function computeActiveUsers(): Promise<KpiResult> {
  return safe(async () => {
    // Total users (across active tenants). "Active" here means the
    // tenant is active; per-user last-active isn't tracked.
    const rows = await db
      .select({ n: count() })
      .from(users)
      .innerJoin(tenants, eq(users.tenantId, tenants.id))
      .where(eq(tenants.active, true));
    return { ...empty(), value: num(rows[0]?.n) };
  });
}

// ─── 11. Avg Bookings Per Tenant ───────────────────────────────────

async function computeAvgBookings(): Promise<KpiResult> {
  return safe(async () => {
    const [bookingsRows, tenantRows] = await Promise.all([
      db.select({ n: count() }).from(bookings).where(gte(bookings.createdAt, days(30))),
      db.select({ n: count() }).from(tenants).where(eq(tenants.active, true)),
    ]);
    const bookings30 = num(bookingsRows[0]?.n);
    const activeTenants = num(tenantRows[0]?.n);
    const v = activeTenants > 0 ? Math.round((bookings30 / activeTenants) * 10) / 10 : null;
    return { ...empty(), value: v };
  });
}

// ─── 12. Trial Conversion Rate ─────────────────────────────────────

async function computeTrialConversion(): Promise<KpiResult> {
  return safe(async () => {
    const [trialRows, activeRows] = await Promise.all([
      db
        .select({ n: count() })
        .from(tenants)
        .where(
          and(eq(tenants.subscriptionStatus, "trialing"), gte(tenants.createdAt, days(30))),
        ),
      db
        .select({ n: count() })
        .from(tenants)
        .where(
          and(eq(tenants.subscriptionStatus, "active"), gte(tenants.createdAt, days(30))),
        ),
    ]);
    const trials = num(trialRows[0]?.n);
    const converted = num(activeRows[0]?.n);
    const denom = trials + converted;
    const v = denom > 0 ? Math.round((converted / denom) * 1000) / 10 : null;
    return { ...empty(), value: v, unit: "percent" };
  });
}

// ─── 13. Avg Revenue Per Tenant (MRR / active-paid count) ──────────

async function computeArpt(mrr: KpiResult, activePaid: KpiResult): Promise<KpiResult> {
  const m = mrr.value;
  const t = activePaid.value;
  const v = m !== null && t !== null && t > 0 ? Math.round(m / t) : null;
  return { ...empty(), value: v, unit: "currency_cents" };
}

// ─── 14. Highest Growth Tenant ────────────────────────────────────

async function computeHighestGrowth(): Promise<KpiResult> {
  return safe(async () => {
    // For each tenant: current 30d bookings vs prior 30d. Return
    // the tenant with the highest absolute growth (not percent —
    // percent inflates tiny absolute changes from low baselines).
    const rows = (await db.execute(
      sql`SELECT t.id, t.name,
                 (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days') AS curr,
                 (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '60 days' AND b.created_at < NOW() - INTERVAL '30 days') AS prev
            FROM tenants t
           WHERE t.active = true
           ORDER BY (
             (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '30 days')
             -
             (SELECT COUNT(*)::int FROM bookings b WHERE b.tenant_id = t.id AND b.created_at >= NOW() - INTERVAL '60 days' AND b.created_at < NOW() - INTERVAL '30 days')
           ) DESC
           LIMIT 1`,
    )) as unknown as Array<{ id: string; name: string; curr: number; prev: number }>;
    const r = rows[0];
    if (!r) return { ...empty(), value: null, unit: "string", label: "—" };
    const delta = num(r.curr) - num(r.prev);
    if (delta <= 0) return { ...empty(), value: null, unit: "string", label: "No growth yet" };
    return {
      value: delta,
      previousValue: null,
      deltaPct: pct(num(r.curr), num(r.prev)),
      sparkline: [],
      unit: "string",
      label: r.name,
    };
  });
}

// ─── 15. Email Delivery Success Rate ───────────────────────────────

async function computeEmailSuccess(): Promise<KpiResult> {
  return safe(async () => {
    const [sentRows, failedRows] = await Promise.all([
      db
        .select({ n: count() })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "email.sent"), gte(auditLogs.createdAt, days(7)))),
      db
        .select({ n: count() })
        .from(auditLogs)
        .where(and(eq(auditLogs.action, "email.failed"), gte(auditLogs.createdAt, days(7)))),
    ]);
    const sent = num(sentRows[0]?.n);
    const failed = num(failedRows[0]?.n);
    const denom = sent + failed;
    if (denom === 0) return { ...empty(), value: null, unit: "percent" };
    const v = Math.round((sent / denom) * 1000) / 10;
    return { ...empty(), value: v, unit: "percent" };
  });
}

// ─── 16. Calendar Sync Health ──────────────────────────────────────

async function computeCalendarSyncHealth(): Promise<KpiResult> {
  return safe(async () => {
    // Numerator: users with google_status in (connected, ok, null).
    // Denominator: users with a google_refresh_token (i.e. ever
    // connected). NULL denominator → no comparison meaningful.
    const rows = (await db.execute(
      sql`SELECT
            (SELECT COUNT(*)::int FROM users WHERE google_refresh_token IS NOT NULL) AS total,
            (SELECT COUNT(*)::int FROM users WHERE google_refresh_token IS NOT NULL AND (google_status IS NULL OR google_status NOT IN ('expired', 'error'))) AS healthy`,
    )) as unknown as Array<{ total: number; healthy: number }>;
    const r = rows[0];
    const total = num(r?.total);
    const healthy = num(r?.healthy);
    if (total === 0) return { ...empty(), value: null, unit: "percent" };
    const v = Math.round((healthy / total) * 1000) / 10;
    return { ...empty(), value: v, unit: "percent" };
  });
}

// ─── Orchestrator ──────────────────────────────────────────────────

/**
 * Compute all 16 KPIs in parallel. Per-KPI failures are isolated
 * (returned as `error` fields), so the bundle always resolves and
 * the dashboard always renders something.
 *
 * Cached for 90s by default — the same dashboard refresh from a
 * second admin tab within the window reads from cache. Pass
 * { skipCache: true } from any "refresh" button if added later.
 */
export async function computeAllKpis(opts?: { skipCache?: boolean }): Promise<KpiBundle> {
  const run = async (): Promise<KpiBundle> => {
    const t0 = Date.now();
    // Compute the leaves first; ARPT and ARR depend on MRR /
    // activePaid so derive those second. Everything else can run
    // in parallel.
    const [
      mrr,
      activePaid,
      trialing,
      churned,
      failedPayments,
      signups7d,
      signups30d,
      totalBookings,
      bookingGrowth,
      activeUsers,
      avgBookings,
      trialConversion,
      highestGrowth,
      emailSuccess,
      calendarSync,
    ] = await Promise.all([
      computeMrr(),
      computeActivePaid(),
      computeTrialing(),
      computeChurned(),
      computeFailedPayments(),
      computeSignups(7),
      computeSignups(30),
      computeTotalBookings(),
      computeBookingGrowth(),
      computeActiveUsers(),
      computeAvgBookings(),
      computeTrialConversion(),
      computeHighestGrowth(),
      computeEmailSuccess(),
      computeCalendarSyncHealth(),
    ]);
    // Derived (need other values).
    const arr = await computeArr(mrr);
    const arpt = await computeArpt(mrr, activePaid);
    return {
      totalMrr: mrr,
      arrProjection: arr,
      activePaidTenants: activePaid,
      trialingTenants: trialing,
      churnedThisMonth: churned,
      failedPayments30d: failedPayments,
      newSignups7d: signups7d,
      newSignups30d: signups30d,
      totalBookings,
      bookingGrowthPct: bookingGrowth,
      totalActiveUsers: activeUsers,
      avgBookingsPerTenant: avgBookings,
      trialConversionPct: trialConversion,
      avgRevenuePerTenant: arpt,
      highestGrowthTenant: highestGrowth,
      emailDeliverySuccessPct: emailSuccess,
      calendarSyncHealthPct: calendarSync,
      computedInMs: Date.now() - t0,
    };
  };
  if (opts?.skipCache) return run();
  return memoize("admin:kpis:v1", run, 90_000);
}

// ─── Side helpers (used by KpiCard tooltip strings) ────────────────

export function kpiTooltip(key: keyof KpiBundle): string {
  const t: Record<string, string> = {
    totalMrr: "Sum of monthly subscription price × tenants with subscriptionStatus='active'. Trialing / past-due not counted.",
    arrProjection: "Annual run rate. MRR × 12. Does not include one-time charges.",
    activePaidTenants: "Tenants on a paid plan (not Free) with status='active' and active=true. Previous = same set 30+ days ago.",
    trialingTenants: "Tenants currently in trial (subscriptionStatus='trialing').",
    churnedThisMonth: "Tenants whose subscription flipped to 'canceled' in the current calendar month. Previous = prior month.",
    failedPayments30d: "Stripe payment_intent.payment_failed + invoice.payment_failed in the last 30 days from billing_transactions.",
    newSignups7d: "Tenants created in the last 7 days.",
    newSignups30d: "Tenants created in the last 30 days.",
    totalBookings: "Lifetime booking count across every tenant.",
    bookingGrowthPct: "Bookings in the last 30 days vs the prior 30 days. Sparkline = last 14 daily totals.",
    totalActiveUsers: "Users in active tenants.",
    avgBookingsPerTenant: "Bookings in last 30 days ÷ active tenants.",
    trialConversionPct: "Of tenants who started a trial in the last 30 days, % that converted to active.",
    avgRevenuePerTenant: "MRR ÷ active-paid tenants.",
    highestGrowthTenant: "Tenant with the largest 30-day booking absolute growth vs prior 30 days.",
    emailDeliverySuccessPct: "audit_logs 'email.sent' ÷ ('email.sent' + 'email.failed') over the last 7 days.",
    calendarSyncHealthPct: "Users with a Google refresh token whose status is not 'expired' or 'error' ÷ users with any Google refresh token.",
  };
  return t[key] ?? "";
}

// Re-export for component imports.
export { isNull };
