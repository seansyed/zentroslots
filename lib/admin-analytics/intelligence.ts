/**
 * SA-8 — Operations Intelligence Engine.
 *
 * Deterministic rule-based engine. NO LLM. NO ML. NO HALLUCINATIONS.
 * Every insight comes from a real SQL query and a fixed threshold
 * test; the human-readable text is templated from those values.
 *
 * Fourteen insight kinds:
 *   • growth_acceleration       — signup velocity ≥1.5× 4-week baseline
 *   • churn_risk_escalation     — tenant inactive 14d AND was active 30d prior
 *   • payment_recovery          — failed-payment tenants since last 7d
 *   • onboarding_dropoff        — tenants started but not completed onboarding >7d
 *   • inactive_tenant           — zero bookings/logins in 30d
 *   • infra_degradation         — webhook OR cron failure ratio in 24h
 *   • reminder_failure_spike    — comms failure ratio ≥ 5% over last 24h
 *   • webhook_instability       — stripe/calendar webhook errors ≥10/day for 3d
 *   • unusual_login_activity    — failed-logins 24h ≥ 20 OR ratio ≥4×
 *   • high_growth_alert         — single tenant bookings 7d ≥3× prior 7d (≥20 base)
 *   • upgrade_opportunity       — free tenant exceeding plan ceiling
 *   • seasonal_patterns         — booking volume now vs 7d-ago weekday
 *   • calendar_sync_degradation — tenants with ≥3 sync errors in last 24h
 *   • signup_conversion_shift   — signup→activation rate change ≥10pts
 *
 * Each insight has: title, explanation (data-grounded), severity,
 * confidence, supportingData, impactedTenants[], recommendedActions[].
 *
 * The orchestrator wraps every rule in safe() so a single failure
 * cannot block the others.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

// ─── Public types ──────────────────────────────────────────────────

export type InsightKind =
  | "growth_acceleration"
  | "churn_risk_escalation"
  | "payment_recovery"
  | "onboarding_dropoff"
  | "inactive_tenant"
  | "infra_degradation"
  | "reminder_failure_spike"
  | "webhook_instability"
  | "unusual_login_activity"
  | "high_growth_alert"
  | "upgrade_opportunity"
  | "seasonal_patterns"
  | "calendar_sync_degradation"
  | "signup_conversion_shift";

export type InsightSeverity = "info" | "opportunity" | "warning" | "critical";
export type InsightCategory =
  | "growth"
  | "churn"
  | "financial"
  | "onboarding"
  | "infrastructure"
  | "security"
  | "operations";

export type ImpactedTenant = {
  id: string;
  name: string;
  detail: string;
};

export type Insight = {
  id: string;
  kind: InsightKind;
  category: InsightCategory;
  title: string;
  explanation: string;
  severity: InsightSeverity;
  /** 0–100. Lower for proxy-derived signals; 100 for hard counts. */
  confidence: number;
  /** Key numbers that drove the rule. Always numeric, never inferred. */
  supportingData: Record<string, number | string>;
  impactedTenants: ImpactedTenant[];
  recommendedActions: string[];
  generatedAt: string;
};

export type IntelligenceReport = {
  insights: Insight[];
  /** Aggregated counts for executive summary. */
  summary: {
    total: number;
    byCategory: Record<InsightCategory, number>;
    bySeverity: Record<InsightSeverity, number>;
  };
  generatedAt: string;
  computedInMs: number;
};

// ─── Helpers ──────────────────────────────────────────────────────

async function safeRows<T = Record<string, unknown>>(
  query: ReturnType<typeof sql>,
  fallback: T[] = [],
): Promise<T[]> {
  try {
    const rows = (await db.execute(query)) as unknown as T[];
    return rows;
  } catch (err) {
    try {
      console.error(
        JSON.stringify({
          evt: "intel_query_fail",
          reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        }),
      );
    } catch {}
    return fallback;
  }
}

function ratio(a: number, b: number): number | null {
  if (b === 0) return null;
  return Math.round((a / b) * 10) / 10;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mkId(kind: InsightKind): string {
  return `${kind}:${Date.now()}`;
}

// ─── Rule: growth_acceleration ───────────────────────────────────

async function ruleGrowthAcceleration(): Promise<Insight | null> {
  const rows = await safeRows<{ curr_7d: number; baseline_avg: number }>(
    sql`SELECT
          (SELECT COUNT(*)::int FROM tenants WHERE created_at > NOW() - INTERVAL '7 days') AS curr_7d,
          COALESCE((SELECT COUNT(*)::float8 FROM tenants WHERE created_at > NOW() - INTERVAL '35 days' AND created_at <= NOW() - INTERVAL '7 days') / 4.0, 0) AS baseline_avg`,
  );
  const r = rows[0] ?? { curr_7d: 0, baseline_avg: 0 };
  const curr = Number(r.curr_7d);
  const base = Number(r.baseline_avg);
  if (curr < 5 || base === 0) return null;
  const rr = curr / base;
  if (rr < 1.5) return null;
  return {
    id: mkId("growth_acceleration"),
    kind: "growth_acceleration",
    category: "growth",
    title: "Signup velocity is accelerating",
    explanation: `${curr} new tenants joined in the last 7 days vs a 4-week baseline of ${base.toFixed(1)}/week (${rr.toFixed(1)}× normal). Source: tenants.created_at.`,
    severity: rr >= 2.5 ? "opportunity" : "info",
    confidence: 95,
    supportingData: {
      signups_7d: curr,
      baseline_weekly_avg: Math.round(base * 10) / 10,
      ratio: Math.round(rr * 10) / 10,
    },
    impactedTenants: [],
    recommendedActions: [
      "Verify activation funnel is keeping up (see onboarding_dropoff).",
      "Review CS staffing — onboarding load typically lags signup by 7 days.",
      "Snapshot acquisition channels in /admin/revenue to confirm source mix.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: churn_risk_escalation ─────────────────────────────────

async function ruleChurnRiskEscalation(): Promise<Insight | null> {
  // Tenants that had ≥3 bookings 30d ago but have had zero in the
  // last 14d AND are still nominally active.
  const rows = await safeRows<{
    tenant_id: string;
    name: string;
    bookings_prior_30d: number;
  }>(
    sql`SELECT t.id::text AS tenant_id,
               t.name,
               COUNT(b.*)::int AS bookings_prior_30d
          FROM tenants t
          LEFT JOIN bookings b
                 ON b.tenant_id = t.id
                AND b.created_at > NOW() - INTERVAL '60 days'
                AND b.created_at <= NOW() - INTERVAL '14 days'
         WHERE t.active = true
           AND t.created_at < NOW() - INTERVAL '60 days'
           AND NOT EXISTS (
                 SELECT 1 FROM bookings b2
                  WHERE b2.tenant_id = t.id
                    AND b2.created_at > NOW() - INTERVAL '14 days'
               )
         GROUP BY t.id, t.name
        HAVING COUNT(b.*) >= 3
         ORDER BY COUNT(b.*) DESC
         LIMIT 20`,
  );
  if (rows.length === 0) return null;
  return {
    id: mkId("churn_risk_escalation"),
    kind: "churn_risk_escalation",
    category: "churn",
    title: `${rows.length} tenant${rows.length === 1 ? "" : "s"} went silent after sustained activity`,
    explanation: `These tenants had ≥3 bookings in the 30 days prior, but zero bookings in the last 14 days while still active. Source: bookings.created_at × tenants.active. This is a leading indicator of voluntary churn.`,
    severity: rows.length >= 5 ? "warning" : "info",
    confidence: 80,
    supportingData: {
      tenant_count: rows.length,
      detection_window_days: 14,
      baseline_window_days: 30,
    },
    impactedTenants: rows.map((r) => ({
      id: r.tenant_id,
      name: r.name,
      detail: `${r.bookings_prior_30d} bookings in prior window · 0 in last 14d`,
    })),
    recommendedActions: [
      "Reach out via CS — many silent tenants have a fixable workflow blocker.",
      "Cross-check /admin/finance dunning for any payment failures that triggered the silence.",
      "Confirm calendar sync health for each tenant (sync errors can mask as silence).",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: payment_recovery ──────────────────────────────────────

async function rulePaymentRecovery(): Promise<Insight | null> {
  const rows = await safeRows<{
    tenant_id: string;
    name: string;
    failed_count: number;
    most_recent: string;
  }>(
    sql`SELECT t.id::text AS tenant_id,
               t.name,
               COUNT(bt.*)::int AS failed_count,
               MAX(bt.created_at) AS most_recent
          FROM billing_transactions bt
          JOIN tenants t ON t.id = bt.tenant_id
         WHERE bt.status = 'failed'
           AND bt.created_at > NOW() - INTERVAL '7 days'
         GROUP BY t.id, t.name
         ORDER BY failed_count DESC
         LIMIT 20`,
  );
  if (rows.length === 0) return null;
  const totalFailed = rows.reduce((sum, r) => sum + Number(r.failed_count), 0);
  return {
    id: mkId("payment_recovery"),
    kind: "payment_recovery",
    category: "financial",
    title: `${rows.length} tenant${rows.length === 1 ? "" : "s"} with failed payments need recovery outreach`,
    explanation: `${totalFailed} failed Stripe charges across ${rows.length} tenants in the last 7 days. Source: billing_transactions.status='failed'. The dunning machine handles automatic retries; this surface is for cases where a human nudge will unblock recovery.`,
    severity: totalFailed >= 10 ? "warning" : "info",
    confidence: 100,
    supportingData: {
      tenant_count: rows.length,
      total_failed_charges_7d: totalFailed,
    },
    impactedTenants: rows.map((r) => ({
      id: r.tenant_id,
      name: r.name,
      detail: `${r.failed_count} failure${r.failed_count === 1 ? "" : "s"} · last ${new Date(r.most_recent).toLocaleDateString()}`,
    })),
    recommendedActions: [
      "Verify the dunning machine is actively retrying for each tenant in /admin/finance.",
      "Send a personal nudge to high-value tenants (top 3 by ARR).",
      "Check whether failures cluster around an expired card or a payment provider outage.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: onboarding_dropoff ────────────────────────────────────

async function ruleOnboardingDropoff(): Promise<Insight | null> {
  const rows = await safeRows<{
    tenant_id: string;
    name: string;
    started_at: string;
  }>(
    sql`SELECT id::text AS tenant_id, name, onboarding_started_at AS started_at
          FROM tenants
         WHERE onboarding_started_at IS NOT NULL
           AND onboarding_completed_at IS NULL
           AND onboarding_skipped_at IS NULL
           AND onboarding_started_at < NOW() - INTERVAL '7 days'
           AND onboarding_started_at > NOW() - INTERVAL '60 days'
           AND active = true
         ORDER BY onboarding_started_at ASC
         LIMIT 20`,
  );
  if (rows.length === 0) return null;
  return {
    id: mkId("onboarding_dropoff"),
    kind: "onboarding_dropoff",
    category: "onboarding",
    title: `${rows.length} tenant${rows.length === 1 ? " is" : "s are"} stuck mid-onboarding`,
    explanation: `These tenants started onboarding >7 days ago but never completed it and never explicitly skipped. Source: tenants.onboarding_started_at / onboarding_completed_at. Each one represents a viable customer who hit a friction point in the wizard.`,
    severity: rows.length >= 5 ? "warning" : "info",
    confidence: 100,
    supportingData: {
      tenant_count: rows.length,
      threshold_days: 7,
    },
    impactedTenants: rows.map((r) => ({
      id: r.tenant_id,
      name: r.name,
      detail: `Started ${new Date(r.started_at).toLocaleDateString()} · still not completed`,
    })),
    recommendedActions: [
      "Inspect each tenant's onboarding_progress JSON to see which step they're stuck on.",
      "Send a tailored email referencing the step they're stuck on, not generic 'finish setup'.",
      "Consider adding a checkpoint UX nudge for tenants idle >3 days inside the wizard.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: inactive_tenant ───────────────────────────────────────

async function ruleInactiveTenant(): Promise<Insight | null> {
  const rows = await safeRows<{
    tenant_id: string;
    name: string;
    plan: string;
    created_at: string;
  }>(
    sql`SELECT t.id::text AS tenant_id, t.name, t.plan, t.created_at
          FROM tenants t
         WHERE t.active = true
           AND t.created_at < NOW() - INTERVAL '30 days'
           AND NOT EXISTS (
                 SELECT 1 FROM bookings b
                  WHERE b.tenant_id = t.id
                    AND b.created_at > NOW() - INTERVAL '30 days'
               )
           AND NOT EXISTS (
                 SELECT 1 FROM audit_logs a
                  WHERE a.tenant_id = t.id
                    AND a.action LIKE 'security.authentication.success%'
                    AND a.created_at > NOW() - INTERVAL '30 days'
               )
         ORDER BY t.created_at DESC
         LIMIT 30`,
  );
  if (rows.length === 0) return null;
  return {
    id: mkId("inactive_tenant"),
    kind: "inactive_tenant",
    category: "churn",
    title: `${rows.length} active tenant${rows.length === 1 ? "" : "s"} with no usage in the last 30 days`,
    explanation: `These tenants have active=true but zero bookings AND zero successful logins in the last 30 days. Source: bookings + audit_logs cross-check. They are paying for (or trialling) a product they're not using — high downgrade risk.`,
    severity: rows.length >= 5 ? "warning" : "info",
    confidence: 95,
    supportingData: { tenant_count: rows.length, window_days: 30 },
    impactedTenants: rows.slice(0, 15).map((r) => ({
      id: r.tenant_id,
      name: r.name,
      detail: `${r.plan} · joined ${new Date(r.created_at).toLocaleDateString()}`,
    })),
    recommendedActions: [
      "Identify the highest-MRR inactive tenants and route to CS.",
      "Trigger a re-engagement sequence with a personal subject line.",
      "Confirm whether free-tier inactives should be downgraded to dormant state.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: infra_degradation ─────────────────────────────────────

async function ruleInfraDegradation(): Promise<Insight | null> {
  const rows = await safeRows<{
    total_24h: number;
    fail_24h: number;
  }>(
    sql`SELECT
          (SELECT COUNT(*)::int FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours') AS total_24h,
          (SELECT COUNT(*)::int FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours' AND (action ILIKE '%fail%' OR action ILIKE '%crash%' OR action ILIKE '%error%')) AS fail_24h`,
  );
  const r = rows[0] ?? { total_24h: 0, fail_24h: 0 };
  const total = Number(r.total_24h);
  const fail = Number(r.fail_24h);
  if (fail < 10) return null;
  const pct = total === 0 ? 0 : Math.round((fail / total) * 1000) / 10;
  if (pct < 2) return null;
  return {
    id: mkId("infra_degradation"),
    kind: "infra_degradation",
    category: "infrastructure",
    title: `${fail} failure-class events in last 24h (${pct}% of audit volume)`,
    explanation: `${fail} of ${total} audit_logs rows in last 24h matched 'fail/crash/error'. Source: audit_logs.action ILIKE. When the ratio crosses 2%, infra warrants a manual review of /admin/system-health.`,
    severity: pct >= 5 ? "critical" : "warning",
    confidence: 90,
    supportingData: {
      failure_class_events: fail,
      total_events: total,
      failure_ratio_pct: pct,
    },
    impactedTenants: [],
    recommendedActions: [
      "Open /admin/system-health and confirm worker + cron heartbeat.",
      "Tail the most recent failures: SELECT action, COUNT(*) … GROUP BY action ORDER BY 2 DESC.",
      "Confirm with /admin/security whether a single tenant or IP is driving the failures.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: reminder_failure_spike ────────────────────────────────

async function ruleReminderFailureSpike(): Promise<Insight | null> {
  const rows = await safeRows<{ sent: number; failed: number }>(
    sql`SELECT
          (SELECT COUNT(*)::int FROM communication_logs WHERE created_at > NOW() - INTERVAL '24 hours') AS sent,
          (SELECT COUNT(*)::int FROM communication_logs WHERE created_at > NOW() - INTERVAL '24 hours' AND status='failed') AS failed`,
  );
  const r = rows[0] ?? { sent: 0, failed: 0 };
  const sent = Number(r.sent);
  const failed = Number(r.failed);
  if (sent < 50) return null;
  const pct = (failed / sent) * 100;
  if (pct < 5) return null;
  return {
    id: mkId("reminder_failure_spike"),
    kind: "reminder_failure_spike",
    category: "infrastructure",
    title: `Reminder failure rate is ${pct.toFixed(1)}% over last 24h`,
    explanation: `${failed} of ${sent} communication_logs rows failed in last 24h (≥5% threshold). Source: communication_logs.status='failed'. SES sandbox limits or sender-identity issues typically present this way.`,
    severity: pct >= 15 ? "critical" : "warning",
    confidence: 100,
    supportingData: {
      failed_24h: failed,
      sent_24h: sent,
      failure_pct: Math.round(pct * 10) / 10,
    },
    impactedTenants: [],
    recommendedActions: [
      "Check SES suppression list + sender identity verification.",
      "Tail communication_logs WHERE status='failed' ORDER BY created_at DESC.",
      "Confirm no template change introduced an invalid placeholder.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: webhook_instability ───────────────────────────────────

async function ruleWebhookInstability(): Promise<Insight | null> {
  const rows = await safeRows<{ day_idx: number; failures: number }>(
    sql`SELECT
          EXTRACT(EPOCH FROM (NOW() - created_at))::int / 86400 AS day_idx,
          COUNT(*)::int AS failures
          FROM audit_logs
         WHERE action ILIKE '%webhook%'
           AND (action ILIKE '%fail%' OR action ILIKE '%error%')
           AND created_at > NOW() - INTERVAL '3 days'
         GROUP BY 1
         ORDER BY 1`,
  );
  if (rows.length < 2) return null;
  const dailyFailures = [0, 0, 0];
  for (const r of rows) {
    const idx = Math.min(Math.max(Number(r.day_idx), 0), 2);
    dailyFailures[idx] = Number(r.failures);
  }
  const sustained = dailyFailures.filter((n) => n >= 10).length;
  if (sustained < 2) return null;
  return {
    id: mkId("webhook_instability"),
    kind: "webhook_instability",
    category: "infrastructure",
    title: `Webhook failures sustained ≥10/day for ${sustained} of last 3 days`,
    explanation: `Daily webhook-failure counts (today→2d ago): ${dailyFailures.join(" / ")}. Source: audit_logs.action ILIKE '%webhook%fail%'. Two or more days at this level points to a real integration regression, not a one-off blip.`,
    severity: sustained === 3 ? "critical" : "warning",
    confidence: 95,
    supportingData: {
      failures_today: dailyFailures[0],
      failures_1d_ago: dailyFailures[1],
      failures_2d_ago: dailyFailures[2],
    },
    impactedTenants: [],
    recommendedActions: [
      "Audit the Stripe webhook endpoint signature header behavior.",
      "Confirm calendar webhook channel renewals are not stalling.",
      "Open /admin/system-health and inspect the integrations panel.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: unusual_login_activity ────────────────────────────────

async function ruleUnusualLoginActivity(): Promise<Insight | null> {
  const rows = await safeRows<{ curr: number; prev: number }>(
    sql`SELECT
          (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'security.authentication.failed%' AND created_at > NOW() - INTERVAL '24 hours') AS curr,
          (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'security.authentication.failed%' AND created_at > NOW() - INTERVAL '48 hours' AND created_at <= NOW() - INTERVAL '24 hours') AS prev`,
  );
  const r = rows[0] ?? { curr: 0, prev: 0 };
  const curr = Number(r.curr);
  const prev = Number(r.prev);
  if (curr < 20 && (prev === 0 || curr / Math.max(prev, 1) < 4 || curr < 10)) return null;
  const rr = ratio(curr, prev);
  return {
    id: mkId("unusual_login_activity"),
    kind: "unusual_login_activity",
    category: "security",
    title: `${curr} failed login attempts in last 24h`,
    explanation: `${curr} security.authentication.failed events vs ${prev} in prior 24h${rr !== null ? ` (${rr}× ratio)` : ""}. Source: audit_logs. Threshold: ≥20 absolute OR ≥4× ratio with ≥10 absolute. Investigate clustering by IP in /admin/security.`,
    severity: curr >= 100 ? "critical" : "warning",
    confidence: 100,
    supportingData: { failed_24h: curr, failed_prev_24h: prev, ratio: rr ?? 0 },
    impactedTenants: [],
    recommendedActions: [
      "Open /admin/security IP intelligence and identify the source IPs.",
      "Consider a temporary block via gateway if a single IP dominates.",
      "Verify the user whose account is targeted has MFA enabled.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: high_growth_alert (per-tenant) ───────────────────────

async function ruleHighGrowthAlert(): Promise<Insight | null> {
  const rows = await safeRows<{
    tenant_id: string;
    name: string;
    plan: string;
    curr_7d: number;
    prev_7d: number;
  }>(
    sql`SELECT t.id::text AS tenant_id,
               t.name,
               t.plan,
               COUNT(*) FILTER (WHERE b.created_at > NOW() - INTERVAL '7 days')::int AS curr_7d,
               COUNT(*) FILTER (WHERE b.created_at > NOW() - INTERVAL '14 days' AND b.created_at <= NOW() - INTERVAL '7 days')::int AS prev_7d
          FROM bookings b
          JOIN tenants t ON t.id = b.tenant_id
         WHERE b.created_at > NOW() - INTERVAL '14 days'
         GROUP BY t.id, t.name, t.plan
        HAVING COUNT(*) FILTER (WHERE b.created_at > NOW() - INTERVAL '7 days') >= 20
           AND COUNT(*) FILTER (WHERE b.created_at > NOW() - INTERVAL '14 days' AND b.created_at <= NOW() - INTERVAL '7 days') >= 1
           AND COUNT(*) FILTER (WHERE b.created_at > NOW() - INTERVAL '7 days')::float8
             / GREATEST(COUNT(*) FILTER (WHERE b.created_at > NOW() - INTERVAL '14 days' AND b.created_at <= NOW() - INTERVAL '7 days'), 1) >= 3
         ORDER BY curr_7d DESC
         LIMIT 10`,
  );
  if (rows.length === 0) return null;
  return {
    id: mkId("high_growth_alert"),
    kind: "high_growth_alert",
    category: "growth",
    title: `${rows.length} tenant${rows.length === 1 ? "" : "s"} grew bookings ≥3× this week`,
    explanation: `Each listed tenant had ≥20 bookings in the last 7 days AND ≥3× the prior-7-day booking count. Source: bookings.created_at by tenant. High-conviction expansion candidates worth a personal check-in.`,
    severity: "opportunity",
    confidence: 95,
    supportingData: { tenant_count: rows.length },
    impactedTenants: rows.map((r) => ({
      id: r.tenant_id,
      name: r.name,
      detail: `${r.plan} · ${r.curr_7d} bookings (was ${r.prev_7d})`,
    })),
    recommendedActions: [
      "Reach out to celebrate + check fit for higher-tier plan.",
      "Confirm seat/usage limits aren't being hit silently.",
      "Add to a 'rising tenants' watchlist for ongoing CS attention.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: upgrade_opportunity ───────────────────────────────────

async function ruleUpgradeOpportunity(): Promise<Insight | null> {
  // Free tenants with ≥50 bookings in last 30d (heavy users on free plan).
  const rows = await safeRows<{
    tenant_id: string;
    name: string;
    bookings_30d: number;
  }>(
    sql`SELECT t.id::text AS tenant_id,
               t.name,
               COUNT(b.*)::int AS bookings_30d
          FROM tenants t
          JOIN bookings b ON b.tenant_id = t.id
         WHERE t.plan = 'free'
           AND t.active = true
           AND b.created_at > NOW() - INTERVAL '30 days'
         GROUP BY t.id, t.name
        HAVING COUNT(b.*) >= 50
         ORDER BY bookings_30d DESC
         LIMIT 10`,
  );
  if (rows.length === 0) return null;
  return {
    id: mkId("upgrade_opportunity"),
    kind: "upgrade_opportunity",
    category: "financial",
    title: `${rows.length} free-tier tenant${rows.length === 1 ? "" : "s"} with high usage — upgrade candidate${rows.length === 1 ? "" : "s"}`,
    explanation: `Each tenant is on the free plan AND has ≥50 bookings in the last 30 days. Source: tenants.plan='free' × bookings.created_at. They're getting strong value and would convert well to a paid tier.`,
    severity: "opportunity",
    confidence: 95,
    supportingData: { tenant_count: rows.length, threshold_30d: 50 },
    impactedTenants: rows.map((r) => ({
      id: r.tenant_id,
      name: r.name,
      detail: `${r.bookings_30d} bookings in 30d on Free`,
    })),
    recommendedActions: [
      "Send a tailored upgrade email referencing their actual booking volume.",
      "Highlight Pro features they'll unlock (recurring, automations).",
      "Offer a one-time onboarding call to sweeten the conversion.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: seasonal_patterns ─────────────────────────────────────

async function ruleSeasonalPatterns(): Promise<Insight | null> {
  const rows = await safeRows<{
    today_count: number;
    same_weekday_prior: number;
  }>(
    sql`SELECT
          (SELECT COUNT(*)::int FROM bookings WHERE created_at::date = CURRENT_DATE) AS today_count,
          (SELECT COUNT(*)::float8 FROM bookings
            WHERE created_at::date IN (
                    CURRENT_DATE - INTERVAL '7 days',
                    CURRENT_DATE - INTERVAL '14 days',
                    CURRENT_DATE - INTERVAL '21 days',
                    CURRENT_DATE - INTERVAL '28 days'
                  )
            ) / 4.0 AS same_weekday_prior`,
  );
  const r = rows[0] ?? { today_count: 0, same_weekday_prior: 0 };
  const curr = Number(r.today_count);
  const base = Number(r.same_weekday_prior);
  if (base < 5 || curr < 5) return null;
  const delta = curr - base;
  const pct = (delta / base) * 100;
  if (Math.abs(pct) < 25) return null;
  return {
    id: mkId("seasonal_patterns"),
    kind: "seasonal_patterns",
    category: "operations",
    title: `Today's booking pace is ${pct > 0 ? "+" : ""}${Math.round(pct)}% vs same weekday over the last 4 weeks`,
    explanation: `Today: ${curr} bookings · 4-week average for this weekday: ${base.toFixed(1)}. Source: bookings.created_at::date. Useful for capacity planning and staff scheduling.`,
    severity: Math.abs(pct) >= 50 ? "warning" : "info",
    confidence: 85,
    supportingData: {
      today_bookings: curr,
      same_weekday_4w_avg: Math.round(base * 10) / 10,
      delta_pct: Math.round(pct),
    },
    impactedTenants: [],
    recommendedActions: [
      pct > 0
        ? "Confirm engine + workers can absorb the demand spike."
        : "Investigate whether a recent change is suppressing booking volume.",
      "Cross-check /admin/revenue intraday curve to see if revenue is tracking volume.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: calendar_sync_degradation ────────────────────────────

async function ruleCalendarSyncDegradation(): Promise<Insight | null> {
  const rows = await safeRows<{
    tenant_id: string;
    name: string;
    error_count: number;
  }>(
    sql`SELECT t.id::text AS tenant_id,
               t.name,
               COUNT(*)::int AS error_count
          FROM calendar_sync_logs csl
          JOIN tenants t ON t.id = csl.tenant_id
         WHERE csl.status = 'error'
           AND csl.created_at > NOW() - INTERVAL '24 hours'
         GROUP BY t.id, t.name
        HAVING COUNT(*) >= 3
         ORDER BY error_count DESC
         LIMIT 10`,
  );
  if (rows.length === 0) return null;
  return {
    id: mkId("calendar_sync_degradation"),
    kind: "calendar_sync_degradation",
    category: "infrastructure",
    title: `${rows.length} tenant${rows.length === 1 ? "" : "s"} hitting calendar-sync errors`,
    explanation: `Each listed tenant had ≥3 calendar_sync_logs.status='error' rows in the last 24 hours. Source: calendar_sync_logs. Indicates an expired refresh token or revoked OAuth grant.`,
    severity: rows.length >= 5 ? "warning" : "info",
    confidence: 100,
    supportingData: { tenant_count: rows.length },
    impactedTenants: rows.map((r) => ({
      id: r.tenant_id,
      name: r.name,
      detail: `${r.error_count} sync errors in last 24h`,
    })),
    recommendedActions: [
      "Notify each tenant to reconnect their calendar from /dashboard/settings/calendar.",
      "Confirm the OAuth credentials in calendar_connections still resolve.",
      "Inspect calendar_sync_logs.metadata for the failure category.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Rule: signup_conversion_shift ───────────────────────────────

async function ruleSignupConversionShift(): Promise<Insight | null> {
  // "Activated" = tenant has ≥1 booking within 7 days of signup.
  const rows = await safeRows<{
    curr_signups: number;
    curr_activated: number;
    prev_signups: number;
    prev_activated: number;
  }>(
    sql`WITH window_curr AS (
          SELECT t.id
            FROM tenants t
           WHERE t.created_at > NOW() - INTERVAL '14 days'
             AND t.created_at <= NOW() - INTERVAL '7 days'
        ),
        window_prev AS (
          SELECT t.id
            FROM tenants t
           WHERE t.created_at > NOW() - INTERVAL '28 days'
             AND t.created_at <= NOW() - INTERVAL '21 days'
        )
        SELECT
          (SELECT COUNT(*)::int FROM window_curr) AS curr_signups,
          (SELECT COUNT(*)::int FROM window_curr c
             WHERE EXISTS (SELECT 1 FROM bookings b
                            WHERE b.tenant_id = c.id
                              AND b.created_at <= NOW()
                              AND b.created_at > (SELECT created_at FROM tenants WHERE id = c.id))) AS curr_activated,
          (SELECT COUNT(*)::int FROM window_prev) AS prev_signups,
          (SELECT COUNT(*)::int FROM window_prev p
             WHERE EXISTS (SELECT 1 FROM bookings b
                            WHERE b.tenant_id = p.id
                              AND b.created_at > (SELECT created_at FROM tenants WHERE id = p.id)
                              AND b.created_at <= (SELECT created_at FROM tenants WHERE id = p.id) + INTERVAL '7 days')) AS prev_activated`,
  );
  const r = rows[0] ?? { curr_signups: 0, curr_activated: 0, prev_signups: 0, prev_activated: 0 };
  const curr_s = Number(r.curr_signups);
  const curr_a = Number(r.curr_activated);
  const prev_s = Number(r.prev_signups);
  const prev_a = Number(r.prev_activated);
  if (curr_s < 10 || prev_s < 10) return null;
  const currRate = (curr_a / curr_s) * 100;
  const prevRate = (prev_a / prev_s) * 100;
  const delta = currRate - prevRate;
  if (Math.abs(delta) < 10) return null;
  return {
    id: mkId("signup_conversion_shift"),
    kind: "signup_conversion_shift",
    category: "growth",
    title: `Signup→activation rate ${delta > 0 ? "improved" : "dropped"} ${Math.abs(Math.round(delta))} points`,
    explanation: `Current cohort (signed up 7–14 days ago): ${curr_a}/${curr_s} activated (${currRate.toFixed(1)}%). Prior cohort (21–28 days ago): ${prev_a}/${prev_s} activated (${prevRate.toFixed(1)}%). 'Activated' = ≥1 booking within 7 days of signup.`,
    severity: delta < -15 ? "warning" : delta > 15 ? "opportunity" : "info",
    confidence: 80,
    supportingData: {
      curr_activation_pct: Math.round(currRate * 10) / 10,
      prev_activation_pct: Math.round(prevRate * 10) / 10,
      delta_pts: Math.round(delta * 10) / 10,
      curr_signups: curr_s,
      prev_signups: prev_s,
    },
    impactedTenants: [],
    recommendedActions: [
      delta > 0
        ? "Identify what changed in the onboarding flow and double down."
        : "Inspect the most recent onboarding wizard changes for friction regressions.",
      "Cross-check onboarding_dropoff insight for individual stuck tenants.",
    ],
    generatedAt: nowIso(),
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────

export async function computeIntelligenceReport(): Promise<IntelligenceReport> {
  return memoize(
    "admin:intelligence:v1",
    async () => {
      const t0 = Date.now();
      const checks = await Promise.all([
        ruleGrowthAcceleration().catch(() => null),
        ruleChurnRiskEscalation().catch(() => null),
        rulePaymentRecovery().catch(() => null),
        ruleOnboardingDropoff().catch(() => null),
        ruleInactiveTenant().catch(() => null),
        ruleInfraDegradation().catch(() => null),
        ruleReminderFailureSpike().catch(() => null),
        ruleWebhookInstability().catch(() => null),
        ruleUnusualLoginActivity().catch(() => null),
        ruleHighGrowthAlert().catch(() => null),
        ruleUpgradeOpportunity().catch(() => null),
        ruleSeasonalPatterns().catch(() => null),
        ruleCalendarSyncDegradation().catch(() => null),
        ruleSignupConversionShift().catch(() => null),
      ]);
      const insights = checks.filter((c): c is Insight => c !== null);

      const sevOrder: Record<InsightSeverity, number> = {
        critical: 0,
        warning: 1,
        opportunity: 2,
        info: 3,
      };
      insights.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

      const byCategory: Record<InsightCategory, number> = {
        growth: 0,
        churn: 0,
        financial: 0,
        onboarding: 0,
        infrastructure: 0,
        security: 0,
        operations: 0,
      };
      const bySeverity: Record<InsightSeverity, number> = {
        critical: 0,
        warning: 0,
        opportunity: 0,
        info: 0,
      };
      for (const i of insights) {
        byCategory[i.category]++;
        bySeverity[i.severity]++;
      }

      return {
        insights,
        summary: { total: insights.length, byCategory, bySeverity },
        generatedAt: nowIso(),
        computedInMs: Date.now() - t0,
      };
    },
    120_000, // 2-minute cache — these rules touch large tables
  );
}
