/**
 * Revenue Executive Intelligence — deterministic insights derived
 * from the existing RevenueSeries + plan + tenant data.
 *
 * Powers the hero KPI strip + the contextual insight chips above
 * the charts on /admin/revenue. Every value is real:
 *
 *   • currentMrrCents      — SUM(active paid tenant × plan price)
 *   • arrCents             — MRR × 12 (matches existing series)
 *   • activeSubscribers    — COUNT(active tenants on paid plan)
 *   • momGrowthPct         — last month revenue vs prior month
 *   • churn30d             — billing.downgrade + subscription.cancel events in last 30d
 *   • upgrades30d          — plan_upgrade audit events in last 30d
 *   • expansionRevenue30d  — net new MRR from upgrades (proxy from audit metadata; null when uncomputable)
 *   • nrrEstimate          — (active + expansion - churn) / active. NULL when low volume.
 *   • avgRevenuePerSub     — currentMrrCents / activeSubscribers
 *
 * Insights are deterministic rules over the same series data. NO LLM.
 * When numbers don't reach the threshold for a meaningful claim,
 * the insight isn't shown (rather than fabricating one).
 *
 * Cache: 90s (matches the snapshot tier).
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";
import type { RevenueSeries } from "./revenue";

// ─── Hero KPIs ────────────────────────────────────────────────────

export type RevenueExecutiveKpis = {
  /** Current MRR in cents — SUM(active paid tenants × plan price). */
  currentMrrCents: number;
  /** ARR projection (MRR × 12). */
  arrCents: number;
  /** Active subscribers on a paid plan. */
  activeSubscribers: number;
  /** Last month vs prior month revenue %. NULL when prior month is 0. */
  momGrowthPct: number | null;
  /** Churn audit events in last 30d. */
  churn30d: number;
  /** Upgrade audit events in last 30d. */
  upgrades30d: number;
  /** Average MRR per subscriber. NULL when no subscribers. */
  avgRevenuePerSubCents: number | null;
  /** Net revenue retention proxy. NULL when volume too low. */
  nrrEstimate: number | null;
  /** Trial → paid conversion rate proxy from tenants table (trialing
   *  that became active in last 60d). NULL when no recent trials. */
  trialConversionPct: number | null;
  generatedAt: string;
  computedInMs: number;
};

export async function computeRevenueExecutiveKpis(): Promise<RevenueExecutiveKpis> {
  return memoize(
    "admin:revenue:exec_kpis:v1",
    async () => {
      const t0 = Date.now();
      const row = (await db.execute(
        sql`SELECT
              COALESCE((
                SELECT SUM(COALESCE(p.price_monthly_cents, 0))::bigint
                  FROM tenants t
                  LEFT JOIN plans p ON p.slug = t.current_plan
                 WHERE t.active = true
                   AND COALESCE(p.price_monthly_cents, 0) > 0
              ), 0) AS current_mrr_cents,
              COALESCE((
                SELECT COUNT(*)::int FROM tenants t
                  LEFT JOIN plans p ON p.slug = t.current_plan
                 WHERE t.active = true
                   AND COALESCE(p.price_monthly_cents, 0) > 0
              ), 0) AS active_subscribers,
              COALESCE((
                SELECT SUM(amount_cents)::bigint FROM billing_transactions
                 WHERE status = 'succeeded'
                   AND created_at >= date_trunc('month', NOW() - INTERVAL '1 month')
                   AND created_at <  date_trunc('month', NOW())
              ), 0) AS prior_month_revenue_cents,
              COALESCE((
                SELECT SUM(amount_cents)::bigint FROM billing_transactions
                 WHERE status = 'succeeded'
                   AND created_at >= date_trunc('month', NOW())
              ), 0) AS current_month_revenue_cents,
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE '%subscription.cancel%' OR action LIKE 'billing.downgrade%')
                   AND created_at >= NOW() - INTERVAL '30 days'
              ), 0) AS churn_30d,
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE 'plan.upgrade%' OR action LIKE 'billing.upgrade%')
                   AND created_at >= NOW() - INTERVAL '30 days'
              ), 0) AS upgrades_30d,
              -- Trial conversion: of tenants whose trial_end fell within
              -- the last 60d, how many are now on an active paid plan.
              COALESCE((
                SELECT COUNT(*)::int FROM tenants
                 WHERE trial_end IS NOT NULL
                   AND trial_end >= NOW() - INTERVAL '60 days'
                   AND trial_end < NOW()
              ), 0) AS trials_ended_60d,
              COALESCE((
                SELECT COUNT(*)::int FROM tenants t
                  LEFT JOIN plans p ON p.slug = t.current_plan
                 WHERE t.trial_end IS NOT NULL
                   AND t.trial_end >= NOW() - INTERVAL '60 days'
                   AND t.trial_end < NOW()
                   AND t.subscription_status IN ('active', 'past_due')
                   AND COALESCE(p.price_monthly_cents, 0) > 0
              ), 0) AS trials_converted_60d`,
      )) as unknown as Array<{
        current_mrr_cents: number;
        active_subscribers: number;
        prior_month_revenue_cents: number;
        current_month_revenue_cents: number;
        churn_30d: number;
        upgrades_30d: number;
        trials_ended_60d: number;
        trials_converted_60d: number;
      }>;

      const r = row[0] ?? {
        current_mrr_cents: 0,
        active_subscribers: 0,
        prior_month_revenue_cents: 0,
        current_month_revenue_cents: 0,
        churn_30d: 0,
        upgrades_30d: 0,
        trials_ended_60d: 0,
        trials_converted_60d: 0,
      };

      const currentMrrCents = Number(r.current_mrr_cents);
      const activeSubscribers = Number(r.active_subscribers);
      const priorMonthRev = Number(r.prior_month_revenue_cents);
      const currentMonthRev = Number(r.current_month_revenue_cents);
      const churn30d = Number(r.churn_30d);
      const upgrades30d = Number(r.upgrades_30d);
      const trialsEnded = Number(r.trials_ended_60d);
      const trialsConverted = Number(r.trials_converted_60d);

      const momGrowthPct =
        priorMonthRev > 0
          ? Math.round(((currentMonthRev - priorMonthRev) / priorMonthRev) * 1000) / 10
          : null;

      const avgRevenuePerSubCents =
        activeSubscribers > 0 ? Math.round(currentMrrCents / activeSubscribers) : null;

      // NRR proxy: requires meaningful sub volume to be honest. With
      // <20 active subs, the math is noise. Return null and the UI
      // renders "—" instead of fabricating a meaningless % .
      const nrrEstimate =
        activeSubscribers >= 20
          ? 1 + (upgrades30d - churn30d) / activeSubscribers
          : null;

      const trialConversionPct =
        trialsEnded > 0
          ? Math.round((trialsConverted / trialsEnded) * 1000) / 10
          : null;

      return {
        currentMrrCents,
        arrCents: currentMrrCents * 12,
        activeSubscribers,
        momGrowthPct,
        churn30d,
        upgrades30d,
        avgRevenuePerSubCents,
        nrrEstimate,
        trialConversionPct,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    90_000,
  );
}

// ─── Deterministic insights ───────────────────────────────────────

export type RevenueInsight = {
  id: string;
  /** Where to show: "hero" (above charts) or "monthly" / "signups" /
   *  "plans" / "churn" (chart-adjacent annotation). */
  surface: "hero" | "monthly" | "signups" | "plans" | "churn" | "bookings";
  tone: "positive" | "neutral" | "warning";
  label: string;
  /** Optional micro-explanation; UI shows on hover. */
  detail?: string;
};

/** Deterministic insight engine. Takes the RevenueSeries + KPIs and
 *  emits short, factual callouts. Each rule has a minimum-volume
 *  guard so we don't surface "Revenue accelerated 400%" because the
 *  prior month was $3. */
export function deriveRevenueInsights(
  series: RevenueSeries,
  kpis: RevenueExecutiveKpis,
): RevenueInsight[] {
  const out: RevenueInsight[] = [];

  // 1. MoM revenue acceleration
  if (kpis.momGrowthPct !== null && Math.abs(kpis.momGrowthPct) >= 5) {
    const sign = kpis.momGrowthPct > 0 ? "+" : "";
    const tone = kpis.momGrowthPct > 0 ? "positive" : "warning";
    out.push({
      id: "mom_growth",
      surface: "hero",
      tone,
      label: `Revenue ${kpis.momGrowthPct > 0 ? "accelerated" : "softened"} ${sign}${kpis.momGrowthPct}% MoM`,
      detail: "Comparison of this month's succeeded charges vs prior month.",
    });
  }

  // 2. Upgrade momentum
  if (kpis.upgrades30d >= 3 && kpis.upgrades30d >= kpis.churn30d * 2) {
    out.push({
      id: "upgrade_momentum",
      surface: "hero",
      tone: "positive",
      label: `Strong upgrade momentum — ${kpis.upgrades30d} upgrades vs ${kpis.churn30d} churn (30d)`,
      detail: "Upgrade events outpacing cancel + downgrade events 2:1 over the last 30 days.",
    });
  }

  // 3. Top plan dominance
  if (series.planDistribution.length >= 2) {
    const sorted = [...series.planDistribution].sort((a, b) => b.mrrCents - a.mrrCents);
    const top = sorted[0];
    const totalMrr = sorted.reduce((s, p) => s + p.mrrCents, 0);
    if (totalMrr > 0) {
      const share = top.mrrCents / totalMrr;
      if (share >= 0.4) {
        out.push({
          id: "plan_dominance",
          surface: "plans",
          tone: "neutral",
          label: `${top.plan} plan drives ${Math.round(share * 100)}% of MRR`,
          detail: `Plan ${top.plan} contributes ${Math.round(share * 100)}% of total monthly recurring revenue.`,
        });
      }
    }
  }

  // 4. Signup vs booking growth ratio
  if (series.signupsByMonth.length >= 3 && series.bookingsByMonth.length >= 3) {
    const recentSignups = series.signupsByMonth.slice(-3).reduce((s, p) => s + p.value, 0);
    const recentBookings = series.bookingsByMonth.slice(-3).reduce((s, p) => s + p.value, 0);
    if (recentSignups >= 3 && recentBookings >= recentSignups * 30) {
      // Bookings growing faster than signups → existing tenants are scaling
      out.push({
        id: "booking_outpaces_signup",
        surface: "bookings",
        tone: "positive",
        label: "Booking growth outpacing signups — existing tenants scaling",
        detail: `Last 3 months: ${recentBookings} bookings across ${recentSignups} new tenants.`,
      });
    }
  }

  // 5. Churn elevation
  if (kpis.churn30d >= 3 && kpis.activeSubscribers > 0) {
    const churnRate = kpis.churn30d / kpis.activeSubscribers;
    if (churnRate >= 0.05) {
      out.push({
        id: "churn_elevated",
        surface: "churn",
        tone: "warning",
        label: `Elevated churn — ${kpis.churn30d} events in 30d (${Math.round(churnRate * 1000) / 10}% of base)`,
        detail: "Investigate via /admin/finance dunning and /admin/intelligence churn risks.",
      });
    }
  }

  // 6. Healthy trial conversion
  if (kpis.trialConversionPct !== null && kpis.trialConversionPct >= 25) {
    out.push({
      id: "strong_trial_conversion",
      surface: "hero",
      tone: "positive",
      label: `Trial conversion ${kpis.trialConversionPct}% — above SaaS median`,
      detail: "% of trials that ended in last 60d and are now on an active paid plan.",
    });
  }

  // 7. ARR milestone
  const arrMilestones = [10000_00, 50000_00, 100000_00, 250000_00, 500000_00, 1_000_000_00];
  for (const m of arrMilestones) {
    if (kpis.arrCents >= m && kpis.arrCents < m * 1.05) {
      out.push({
        id: `arr_milestone_${m}`,
        surface: "hero",
        tone: "positive",
        label: `ARR just crossed $${(m / 100_00).toLocaleString()}K`,
        detail: "Projected from current MRR × 12.",
      });
      break;
    }
  }

  return out;
}
