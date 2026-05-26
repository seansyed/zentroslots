/**
 * Finance Executive Intelligence — deterministic KPIs + insights for
 * /admin/finance. Powers the executive hero strip + chart-adjacent
 * insight chips + the Dunning Center health overlay.
 *
 * Philosophy (same as revenue-intelligence.ts):
 *   • Every metric maps to a real SQL query.
 *   • NULL when the math is uncomputable (no prior period, low volume).
 *   • UI renders "—" rather than fabricating a 0%.
 *   • Insights are threshold-tested SQL facts. NO LLM. NO ML.
 *
 * Hero tiles (7):
 *   • Current MRR           — animated
 *   • ARR projection        — MRR × 12
 *   • Net revenue retention — (active + expansion - churn) / active
 *   • Expansion revenue     — net MRR diff from upgrade audit events (30d)
 *   • Churn impact          — lost MRR from canceled subs (30d)
 *   • Collections velocity  — collections this month / 30 days
 *   • Payment health score  — composite of success rate, dunning size,
 *                             past_due ratio. 0–100. NULL at low volume.
 *
 * Cache: 90s (matches the dashboard tier).
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";
import type { FinanceBundle } from "./finance";
import type { DunningPage } from "./dunning";

// ─── Hero KPIs ────────────────────────────────────────────────────

export type FinanceExecutiveKpis = {
  /** Current MRR cents — SUM(active paid × plan price). */
  currentMrrCents: number;
  /** ARR projection (MRR × 12). */
  arrCents: number;
  /** Active paying subscribers. */
  activeSubscribers: number;
  /** Net revenue retention proxy. NULL at <20 subs. */
  nrrEstimate: number | null;
  /** Expansion MRR delta in cents (upgrades 30d). NULL when uncomputable. */
  expansionMrrCents: number | null;
  /** Churn impact in cents — lost MRR last 30d. */
  churnImpactCents: number;
  /** Collections this month in cents. */
  collectionsThisMonthCents: number;
  /** Collections growth vs prior month %. NULL when prior=0. */
  collectionsMomPct: number | null;
  /** Payment health score 0-100. NULL at low volume. */
  paymentHealthScore: number | null;
  /** Payment health tone classification. */
  paymentHealthTone: "healthy" | "warning" | "critical" | "neutral";
  /** Stripe succeeded / (succeeded + failed) — last 30d. NULL at low volume. */
  paymentSuccessRate: number | null;
  /** Count of tenants currently past_due. */
  pastDueCount: number;
  /** Total recoverable MRR sitting in dunning. */
  dunningRecoverableMrrCents: number;
  generatedAt: string;
  computedInMs: number;
};

export async function computeFinanceExecutiveKpis(): Promise<FinanceExecutiveKpis> {
  return memoize(
    "admin:finance:exec_kpis:v1",
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
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE 'plan.upgrade%' OR action LIKE 'billing.upgrade%')
                   AND created_at >= NOW() - INTERVAL '30 days'
              ), 0) AS upgrades_30d,
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE '%subscription.cancel%' OR action LIKE 'billing.downgrade%')
                   AND created_at >= NOW() - INTERVAL '30 days'
              ), 0) AS churn_30d,
              COALESCE((
                SELECT SUM(COALESCE(p.price_monthly_cents, 0))::bigint
                  FROM tenants t
                  LEFT JOIN plans p ON p.slug = t.current_plan
                 WHERE t.subscription_status = 'canceled'
                   AND t.updated_at >= NOW() - INTERVAL '30 days'
              ), 0) AS churn_impact_cents,
              COALESCE((
                SELECT SUM(amount_cents)::bigint FROM billing_transactions
                 WHERE status = 'succeeded'
                   AND transaction_type != 'refund'
                   AND created_at >= date_trunc('month', NOW())
              ), 0) AS collections_this_month_cents,
              COALESCE((
                SELECT SUM(amount_cents)::bigint FROM billing_transactions
                 WHERE status = 'succeeded'
                   AND transaction_type != 'refund'
                   AND created_at >= date_trunc('month', NOW() - INTERVAL '1 month')
                   AND created_at <  date_trunc('month', NOW())
              ), 0) AS collections_prior_month_cents,
              COALESCE((
                SELECT COUNT(*)::int FROM billing_transactions
                 WHERE status = 'succeeded'
                   AND created_at >= NOW() - INTERVAL '30 days'
              ), 0) AS payments_succeeded_30d,
              COALESCE((
                SELECT COUNT(*)::int FROM billing_transactions
                 WHERE status = 'failed'
                   AND created_at >= NOW() - INTERVAL '30 days'
              ), 0) AS payments_failed_30d,
              COALESCE((
                SELECT COUNT(*)::int FROM tenants WHERE subscription_status = 'past_due'
              ), 0) AS past_due_count,
              COALESCE((
                SELECT SUM(COALESCE(p.price_monthly_cents, 0))::bigint
                  FROM tenants t
                  LEFT JOIN plans p ON p.slug = t.current_plan
                 WHERE t.subscription_status = 'past_due'
              ), 0) AS dunning_recoverable_mrr_cents,
              -- Expansion MRR delta: difference in cumulative MRR over
              -- the upgrade audit events from the last 30d. We use the
              -- count × avg_plan_step as a deterministic proxy because
              -- audit_logs.metadata doesn't reliably carry the delta.
              COALESCE((
                SELECT AVG(NULLIF(price_monthly_cents, 0))::int
                  FROM plans WHERE active = true
              ), 0) AS avg_plan_step_cents`,
      )) as unknown as Array<{
        current_mrr_cents: number;
        active_subscribers: number;
        upgrades_30d: number;
        churn_30d: number;
        churn_impact_cents: number;
        collections_this_month_cents: number;
        collections_prior_month_cents: number;
        payments_succeeded_30d: number;
        payments_failed_30d: number;
        past_due_count: number;
        dunning_recoverable_mrr_cents: number;
        avg_plan_step_cents: number;
      }>;

      const r = row[0] ?? {
        current_mrr_cents: 0,
        active_subscribers: 0,
        upgrades_30d: 0,
        churn_30d: 0,
        churn_impact_cents: 0,
        collections_this_month_cents: 0,
        collections_prior_month_cents: 0,
        payments_succeeded_30d: 0,
        payments_failed_30d: 0,
        past_due_count: 0,
        dunning_recoverable_mrr_cents: 0,
        avg_plan_step_cents: 0,
      };

      const currentMrrCents = Number(r.current_mrr_cents);
      const activeSubscribers = Number(r.active_subscribers);
      const upgrades30d = Number(r.upgrades_30d);
      const churn30d = Number(r.churn_30d);
      const churnImpactCents = Number(r.churn_impact_cents);
      const collectionsThisMonthCents = Number(r.collections_this_month_cents);
      const collectionsPriorMonthCents = Number(r.collections_prior_month_cents);
      const paymentsSucceeded = Number(r.payments_succeeded_30d);
      const paymentsFailed = Number(r.payments_failed_30d);
      const pastDueCount = Number(r.past_due_count);
      const dunningRecoverableMrrCents = Number(r.dunning_recoverable_mrr_cents);
      const avgPlanStepCents = Number(r.avg_plan_step_cents);

      // NRR proxy — requires meaningful base.
      const nrrEstimate =
        activeSubscribers >= 20
          ? 1 + (upgrades30d - churn30d) / activeSubscribers
          : null;

      // Expansion MRR delta proxy: upgrades_30d × avg_plan_step.
      // Honest because we don't have per-event metadata for the actual
      // delta; we use this only as a magnitude estimate.
      const expansionMrrCents =
        upgrades30d > 0 && avgPlanStepCents > 0
          ? upgrades30d * avgPlanStepCents
          : null;

      // Collections MoM growth (last month vs prior month).
      const collectionsMomPct =
        collectionsPriorMonthCents > 0
          ? Math.round(
              ((collectionsThisMonthCents - collectionsPriorMonthCents) /
                collectionsPriorMonthCents) *
                1000,
            ) / 10
          : null;

      // Payment success rate (last 30d).
      const totalPayments = paymentsSucceeded + paymentsFailed;
      const paymentSuccessRate =
        totalPayments >= 10
          ? Math.round((paymentsSucceeded / totalPayments) * 1000) / 10
          : null;

      // Composite payment health score 0-100. Components:
      //  • payment success rate (0-50 pts)
      //  • dunning size vs active base (0-25 pts) — fewer past_due = higher
      //  • churn vs upgrade balance (0-25 pts)
      // Returns NULL when we don't have enough data to be honest.
      let paymentHealthScore: number | null = null;
      if (paymentSuccessRate !== null && activeSubscribers >= 5) {
        const successScore = (paymentSuccessRate / 100) * 50;
        const dunningRatio = pastDueCount / Math.max(1, activeSubscribers);
        // 0% dunning = 25 pts, 20%+ dunning = 0 pts.
        const dunningScore = Math.max(0, 25 - dunningRatio * 125);
        // Balanced/positive churn = 25; net negative subtracts.
        const churnBalance = upgrades30d - churn30d;
        const churnScore =
          churnBalance >= 0
            ? 25
            : Math.max(0, 25 + (churnBalance / Math.max(1, activeSubscribers)) * 100);
        paymentHealthScore = Math.round(successScore + dunningScore + churnScore);
      }

      const paymentHealthTone: FinanceExecutiveKpis["paymentHealthTone"] =
        paymentHealthScore === null
          ? "neutral"
          : paymentHealthScore >= 85
          ? "healthy"
          : paymentHealthScore >= 65
          ? "warning"
          : "critical";

      return {
        currentMrrCents,
        arrCents: currentMrrCents * 12,
        activeSubscribers,
        nrrEstimate,
        expansionMrrCents,
        churnImpactCents,
        collectionsThisMonthCents,
        collectionsMomPct,
        paymentHealthScore,
        paymentHealthTone,
        paymentSuccessRate,
        pastDueCount,
        dunningRecoverableMrrCents,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    90_000,
  );
}

// ─── Deterministic finance insights ───────────────────────────────

export type FinanceInsight = {
  id: string;
  /** Where to render: hero strip, chart-adjacent, or dunning header. */
  surface: "hero" | "collections" | "mrr" | "churn" | "failures" | "dunning";
  tone: "positive" | "neutral" | "warning" | "critical";
  label: string;
  detail?: string;
};

/**
 * Deterministic insight engine. Threshold-tested SQL facts only.
 * Volume guards ensure we never claim "Collections increased 400%"
 * because last month was $3.
 */
export function deriveFinanceInsights(
  bundle: FinanceBundle,
  kpis: FinanceExecutiveKpis,
  dunning: DunningPage | null,
): FinanceInsight[] {
  const out: FinanceInsight[] = [];

  // 1. Collections MoM acceleration (≥10%, with $500 floor).
  if (
    kpis.collectionsMomPct !== null &&
    Math.abs(kpis.collectionsMomPct) >= 10 &&
    kpis.collectionsThisMonthCents >= 50_000
  ) {
    const direction = kpis.collectionsMomPct > 0 ? "increased" : "softened";
    const sign = kpis.collectionsMomPct > 0 ? "+" : "";
    out.push({
      id: "collections_mom",
      surface: "collections",
      tone: kpis.collectionsMomPct > 0 ? "positive" : "warning",
      label: `Collections ${direction} ${sign}${kpis.collectionsMomPct}% MoM`,
      detail: "Month-to-date succeeded charges vs the prior calendar month.",
    });
  }

  // 2. Failed payments accelerating — 3mo trend slope.
  if (bundle.failedPaymentsTrend.length >= 3) {
    const recent3 = bundle.failedPaymentsTrend.slice(-3).map((p) => p.value);
    const prior3 = bundle.failedPaymentsTrend.slice(-6, -3).map((p) => p.value);
    const recentSum = recent3.reduce((s, n) => s + n, 0);
    const priorSum = prior3.reduce((s, n) => s + n, 0);
    if (recentSum >= 5 && recentSum >= priorSum * 1.5) {
      out.push({
        id: "failed_payments_accelerating",
        surface: "failures",
        tone: "warning",
        label: `Failed payments accelerating — ${recentSum} in last 3 months`,
        detail: `Up from ${priorSum} the prior 3-month window. Review dunning queue.`,
      });
    }
  }

  // 3. Upgrade momentum (or its absence).
  const recentUp = bundle.upgradeDowngradeTrend.slice(-3).reduce((s, p) => s + p.a, 0);
  const priorUp = bundle.upgradeDowngradeTrend.slice(-6, -3).reduce((s, p) => s + p.a, 0);
  if (recentUp >= 3 && priorUp >= 3) {
    if (recentUp >= priorUp * 1.5) {
      out.push({
        id: "upgrade_momentum_strong",
        surface: "mrr",
        tone: "positive",
        label: `Upgrade momentum building — ${recentUp} upgrades in last 90d`,
        detail: `Up from ${priorUp} the prior 90-day window.`,
      });
    } else if (recentUp <= priorUp * 0.6) {
      out.push({
        id: "upgrade_momentum_slowing",
        surface: "mrr",
        tone: "warning",
        label: `Upgrade momentum slowing — ${recentUp} vs ${priorUp} prior`,
        detail: "Last 90d vs prior 90d. Consider expansion campaigns.",
      });
    }
  }

  // 4. Dunning recovery weakening — high count with critical tier ≥40%.
  if (dunning && dunning.tenants.length >= 5) {
    const critical = dunning.tenants.filter((t) => t.riskTier === "critical").length;
    const ratio = critical / dunning.tenants.length;
    if (ratio >= 0.4) {
      out.push({
        id: "dunning_recovery_weakening",
        surface: "dunning",
        tone: "critical",
        label: `Dunning recovery weakening — ${critical}/${dunning.tenants.length} critical`,
        detail: "Tenants aged past 15-day grace; recovery probability collapsing.",
      });
    } else if (
      dunning.tenants.filter((t) => t.riskTier === "recoverable").length >=
      dunning.tenants.length * 0.6
    ) {
      out.push({
        id: "dunning_healthy_recovery",
        surface: "dunning",
        tone: "positive",
        label: `Recovery profile healthy — ${Math.round(
          (dunning.tenants.filter((t) => t.riskTier === "recoverable").length /
            dunning.tenants.length) *
            100,
        )}% within retry window`,
        detail: "Most past-due tenants are still in the recoverable 0–3 day band.",
      });
    }
  }

  // 5. Churn impact above 5% of MRR.
  if (
    kpis.currentMrrCents > 0 &&
    kpis.churnImpactCents / kpis.currentMrrCents >= 0.05 &&
    kpis.churnImpactCents >= 5_000
  ) {
    out.push({
      id: "churn_impact_elevated",
      surface: "churn",
      tone: "warning",
      label: `Churn impact ${Math.round(
        (kpis.churnImpactCents / kpis.currentMrrCents) * 1000,
      ) / 10}% of MRR`,
      detail: `${(kpis.churnImpactCents / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      })} lost MRR over the last 30 days.`,
    });
  }

  // 6. NRR > 100% — expansion outpacing churn.
  if (kpis.nrrEstimate !== null && kpis.nrrEstimate >= 1.05) {
    out.push({
      id: "nrr_expansion",
      surface: "hero",
      tone: "positive",
      label: `NRR ${Math.round(kpis.nrrEstimate * 100)}% — expansion outpacing churn`,
      detail: "Upgrade audit events exceeded cancel + downgrade over the last 30 days.",
    });
  }

  // 7. Payment health critical.
  if (kpis.paymentHealthTone === "critical" && kpis.paymentHealthScore !== null) {
    out.push({
      id: "payment_health_critical",
      surface: "hero",
      tone: "critical",
      label: `Payment health score ${kpis.paymentHealthScore} — needs attention`,
      detail: "Composite of success rate, dunning ratio, and net churn balance.",
    });
  }

  return out;
}
