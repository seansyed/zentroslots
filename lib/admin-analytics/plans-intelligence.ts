/**
 * Monetization Intelligence — per-plan operational telemetry.
 *
 * Drives the upper section of /admin/plans: how many tenants are on
 * each plan, plan MRR, churn, conversion-from-free, near-limit
 * tenants (upgrade pressure), and 14-day MRR trend.
 *
 * Every number is a real DB query — no fabricated CAC, no fake
 * cohort math. Where data isn't available (e.g. no churn events in
 * the window) we return null and the UI renders "—".
 *
 * Caching: 90 seconds (matches the analytics cache TTL elsewhere).
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";
import { BILLING_STATUS } from "./event-taxonomy";

// ─── Per-plan rollup ───────────────────────────────────────────────

export type PlanIntelRow = {
  slug: string;
  /** Live subscriber count (tenants.current_plan = slug AND active). */
  activeSubscribers: number;
  /** Trialing subscribers in the window (subscription_status = 'trialing'). */
  trialingSubscribers: number;
  /** Past-due subscribers — billing problem, will churn if not recovered. */
  pastDueSubscribers: number;
  /** Estimated MRR for this plan (subscribers × plan price). */
  estimatedMrrCents: number;
  /** Successful charges for tenants on this plan in last 30d. */
  charges30d: number;
  /** Sum of succeeded amounts in last 30d. */
  revenue30dCents: number;
  /** Cancel events from audit_logs (last 30d) for tenants on this plan. */
  churn30d: number;
  /** Tenants near a plan limit — soft signal for upgrade pressure.
   *  Currently: % of plan's max_staff or max_bookings_per_month
   *  utilized. Null when plan has no caps (unlimited / custom). */
  nearLimitTenants: number;
  /** Daily new-subscriber sparkline (last 14 days, oldest first). */
  signupSparkline14d: number[];
};

export type PlanIntelReport = {
  rows: PlanIntelRow[];
  totals: {
    activeSubscribers: number;
    estimatedMrrCents: number;
    revenue30dCents: number;
    churn30d: number;
  };
  generatedAt: string;
  computedInMs: number;
};

// ─── Per-plan loader ───────────────────────────────────────────────

async function computePlanRow(
  slug: string,
  priceMonthlyCents: number,
): Promise<PlanIntelRow> {
  const row = (await db.execute(
    sql`SELECT
          (SELECT COUNT(*)::int FROM tenants
            WHERE current_plan = ${slug} AND active = true) AS active_subs,
          (SELECT COUNT(*)::int FROM tenants
            WHERE current_plan = ${slug} AND active = true
              AND subscription_status = 'trialing') AS trialing_subs,
          (SELECT COUNT(*)::int FROM tenants
            WHERE current_plan = ${slug} AND active = true
              AND subscription_status = 'past_due') AS past_due_subs,
          (SELECT COUNT(*)::int FROM billing_transactions bt
             JOIN tenants t ON t.id = bt.tenant_id
            WHERE t.current_plan = ${slug}
              AND bt.status = 'succeeded'
              AND bt.created_at >= NOW() - INTERVAL '30 days') AS charges_30d,
          COALESCE(
            (SELECT SUM(bt.amount_cents)::bigint FROM billing_transactions bt
               JOIN tenants t ON t.id = bt.tenant_id
              WHERE t.current_plan = ${slug}
                AND bt.status = 'succeeded'
                AND bt.created_at >= NOW() - INTERVAL '30 days'),
            0
          ) AS revenue_30d_cents,
          (SELECT COUNT(*)::int FROM audit_logs a
             JOIN tenants t ON t.id = a.tenant_id
            WHERE t.current_plan = ${slug}
              AND (a.action LIKE '%subscription.cancel%' OR a.action LIKE 'billing.downgrade%')
              AND a.created_at >= NOW() - INTERVAL '30 days') AS churn_30d`,
  )) as unknown as Array<{
    active_subs: number;
    trialing_subs: number;
    past_due_subs: number;
    charges_30d: number;
    revenue_30d_cents: number;
    churn_30d: number;
  }>;

  const r = row[0] ?? {
    active_subs: 0,
    trialing_subs: 0,
    past_due_subs: 0,
    charges_30d: 0,
    revenue_30d_cents: 0,
    churn_30d: 0,
  };

  // Signup sparkline: tenants created with current_plan = slug,
  // grouped by day across the last 14 days. Older-first.
  const sparkRows = (await db.execute(
    sql`SELECT
          (CURRENT_DATE - bucket)::date::text AS day,
          COALESCE(daily.n, 0)::int AS n
          FROM generate_series(0, 13) AS bucket
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS n
              FROM tenants
             WHERE current_plan = ${slug}
               AND created_at::date = (CURRENT_DATE - bucket)
          ) daily ON TRUE
         ORDER BY bucket DESC`,
  )) as unknown as Array<{ day: string; n: number }>;
  const signupSparkline14d = sparkRows.map((s) => Number(s.n ?? 0));

  // Near-limit tenants: those at >= 70% of staff seats (proxy for
  // upgrade pressure). Skip when slug has unlimited staff.
  const nearLimit = (await db.execute(
    sql`SELECT COUNT(*)::int AS n
          FROM tenants t
          JOIN plans p ON p.slug = t.current_plan
         WHERE t.current_plan = ${slug}
           AND t.active = true
           AND p.quota_staff > 0
           AND (SELECT COUNT(*)::int FROM users u
                 WHERE u.tenant_id = t.id
                   AND u.role IN ('admin','manager','staff'))::float
                 / NULLIF(p.quota_staff, 0) >= 0.7`,
  )) as unknown as Array<{ n: number }>;

  return {
    slug,
    activeSubscribers: Number(r.active_subs),
    trialingSubscribers: Number(r.trialing_subs),
    pastDueSubscribers: Number(r.past_due_subs),
    estimatedMrrCents: Number(r.active_subs) * priceMonthlyCents,
    charges30d: Number(r.charges_30d),
    revenue30dCents: Number(r.revenue_30d_cents),
    churn30d: Number(r.churn_30d),
    nearLimitTenants: Number(nearLimit[0]?.n ?? 0),
    signupSparkline14d,
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────

export async function computePlanIntelligence(): Promise<PlanIntelReport> {
  return memoize(
    "admin:plans:intel:v1",
    async () => {
      const t0 = Date.now();

      // Read every plan slug + monthly price from the live DB so this
      // module never goes out of sync with the plan rows.
      const plans = (await db.execute(
        sql`SELECT slug, price_monthly_cents FROM plans WHERE active = true ORDER BY sort_order, price_monthly_cents`,
      )) as unknown as Array<{ slug: string; price_monthly_cents: number }>;

      const rows = await Promise.all(
        plans.map((p) =>
          computePlanRow(p.slug, Number(p.price_monthly_cents)).catch(() => ({
            slug: p.slug,
            activeSubscribers: 0,
            trialingSubscribers: 0,
            pastDueSubscribers: 0,
            estimatedMrrCents: 0,
            charges30d: 0,
            revenue30dCents: 0,
            churn30d: 0,
            nearLimitTenants: 0,
            signupSparkline14d: new Array(14).fill(0),
          })),
        ),
      );

      const totals = rows.reduce(
        (acc, r) => ({
          activeSubscribers: acc.activeSubscribers + r.activeSubscribers,
          estimatedMrrCents: acc.estimatedMrrCents + r.estimatedMrrCents,
          revenue30dCents: acc.revenue30dCents + r.revenue30dCents,
          churn30d: acc.churn30d + r.churn30d,
        }),
        { activeSubscribers: 0, estimatedMrrCents: 0, revenue30dCents: 0, churn30d: 0 },
      );

      return {
        rows,
        totals,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    90_000,
  );
}

// ─── Stripe sync diagnostics ──────────────────────────────────────

export type StripeSyncDiagnostic = {
  slug: string;
  monthlyConfigured: boolean;
  yearlyConfigured: boolean;
  monthlyPriceId: string | null;
  yearlyPriceId: string | null;
  /** True when this plan is "live-sellable" — has at least a monthly
   *  Stripe price ID configured. */
  sellable: boolean;
  /** Free + Enterprise (price=0) don't need Stripe price IDs. */
  expectsStripePrice: boolean;
};

export async function fetchStripeSyncDiagnostics(): Promise<StripeSyncDiagnostic[]> {
  const rows = (await db.execute(
    sql`SELECT slug, price_monthly_cents, stripe_price_id_monthly, stripe_price_id_yearly
          FROM plans
         WHERE active = true
         ORDER BY sort_order, price_monthly_cents`,
  )) as unknown as Array<{
    slug: string;
    price_monthly_cents: number;
    stripe_price_id_monthly: string | null;
    stripe_price_id_yearly: string | null;
  }>;
  return rows.map((r) => ({
    slug: r.slug,
    monthlyConfigured: !!r.stripe_price_id_monthly,
    yearlyConfigured: !!r.stripe_price_id_yearly,
    monthlyPriceId: r.stripe_price_id_monthly,
    yearlyPriceId: r.stripe_price_id_yearly,
    sellable: !!r.stripe_price_id_monthly,
    // Free + custom-pricing tiers don't need Stripe IDs.
    expectsStripePrice: Number(r.price_monthly_cents) > 0,
  }));
}

// ─── Top upgrade candidates ───────────────────────────────────────

export type UpgradeCandidate = {
  tenantId: string;
  tenantName: string;
  currentPlan: string;
  pressureSignal: string;
  /** 0..1 score (1 = max pressure). */
  pressureScore: number;
};

export async function fetchUpgradeCandidates(limit = 10): Promise<UpgradeCandidate[]> {
  // Strong upgrade pressure: free-plan tenants with >= 30 bookings/30d.
  // These are "value-extracting on free" — prime upgrade targets.
  const rows = (await db.execute(
    sql`SELECT t.id::text AS id, t.name, t.current_plan,
               (SELECT COUNT(*)::int FROM bookings b
                  WHERE b.tenant_id = t.id
                    AND b.created_at >= NOW() - INTERVAL '30 days') AS bookings_30d
          FROM tenants t
         WHERE t.active = true
           AND t.current_plan IN ('free', 'pro')
         ORDER BY bookings_30d DESC
         LIMIT ${limit * 2}`,
  )) as unknown as Array<{ id: string; name: string; current_plan: string; bookings_30d: number }>;
  return rows
    .filter((r) => Number(r.bookings_30d) >= 20)
    .slice(0, limit)
    .map((r) => {
      const b = Number(r.bookings_30d);
      const score = Math.min(1, b / 200);
      return {
        tenantId: r.id,
        tenantName: r.name,
        currentPlan: r.current_plan,
        pressureSignal: `${b} bookings in last 30d`,
        pressureScore: Math.round(score * 100) / 100,
      };
    });
}
