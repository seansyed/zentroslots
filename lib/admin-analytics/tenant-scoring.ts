/**
 * SA-4 — Tenant health + risk scoring engines.
 *
 * Pure functions. NO mock data, NO randomness, NO heuristics that
 * fabricate values. Every input field comes from a real DB query
 * in lib/admin-analytics/tenant-intelligence.ts.
 *
 * Both engines are deterministic — same inputs → same scores. They
 * never call DB or external services.
 *
 * HEALTH (0-100, higher = healthier):
 *   8 weighted factors:
 *     • recent_activity        20pts   bookings in last 7 days > 0
 *     • booking_growth         15pts   30d growth ≥ 0
 *     • active_users           10pts   ≥ 1 active user
 *     • payment_status         15pts   subscription not past_due
 *     • integrations_connected 10pts   Google OR Microsoft connected
 *     • reminder_success       10pts   ≥ 90% reminder delivery
 *     • onboarding_completion  10pts   onboarding_completed_at set
 *     • usage_frequency        10pts   booking in last 30 days
 *   Score is the SUM of points earned (clamped 0..100).
 *
 * RISK (Low | Medium | High | Critical):
 *   6 factors, each adding a weighted "risk count":
 *     • declining_bookings        +2  30d < 50% of prior 30d
 *     • failed_payments           +3  ≥1 failed payment in last 30 days
 *     • inactivity                +2  no bookings in last 30 days
 *     • expired_integrations      +1  Google/MS token expired
 *     • churn_signals             +2  status past_due or canceled
 *     • low_engagement            +1  < 1 user per active tenant
 *   Total mapped:
 *     0-1   → Low
 *     2-3   → Medium
 *     4-5   → High
 *     6+    → Critical
 *
 * Churn probability is a derived signal: a 0-100% scale produced
 * from the risk count (riskCount × 14, clamped to 95).
 */

export type TenantHealthSignal = {
  recent_activity: boolean;
  booking_growth: number; // 30d vs prior 30d
  active_users: number;
  past_due: boolean;
  google_connected: boolean;
  microsoft_connected: boolean;
  reminder_success_pct: number | null; // 0..100; null = no signal
  onboarding_completed: boolean;
  usage_frequency: boolean; // booking in last 30d
};

export type TenantRiskSignal = {
  bookings_30d: number;
  bookings_prior_30d: number;
  failed_payments_30d: number;
  subscription_status: string | null;
  google_expired: boolean;
  microsoft_expired: boolean;
  active_users: number;
};

export type RiskLevel = "low" | "medium" | "high" | "critical";

/** Health: 0-100 integer, higher = healthier. */
export function computeHealthScore(s: TenantHealthSignal): number {
  let pts = 0;
  if (s.recent_activity) pts += 20;
  if (s.booking_growth >= 0) pts += 15;
  if (s.active_users >= 1) pts += 10;
  if (!s.past_due) pts += 15;
  if (s.google_connected || s.microsoft_connected) pts += 10;
  // Reminder success: 10pts if ≥90%, 5pts if ≥70%, 0 otherwise.
  // Null (no signal) = neutral 5pts.
  if (s.reminder_success_pct === null) pts += 5;
  else if (s.reminder_success_pct >= 90) pts += 10;
  else if (s.reminder_success_pct >= 70) pts += 5;
  if (s.onboarding_completed) pts += 10;
  if (s.usage_frequency) pts += 10;
  return Math.max(0, Math.min(100, pts));
}

/** Risk: categorical level + numeric count + churn probability. */
export function computeRisk(s: TenantRiskSignal): {
  level: RiskLevel;
  count: number;
  churnProbabilityPct: number;
  factors: string[];
} {
  let count = 0;
  const factors: string[] = [];
  if (s.bookings_prior_30d > 0 && s.bookings_30d < s.bookings_prior_30d / 2) {
    count += 2;
    factors.push("declining_bookings");
  }
  if (s.failed_payments_30d >= 1) {
    count += 3;
    factors.push("failed_payments");
  }
  if (s.bookings_30d === 0) {
    count += 2;
    factors.push("inactivity");
  }
  if (s.google_expired || s.microsoft_expired) {
    count += 1;
    factors.push("expired_integrations");
  }
  if (s.subscription_status === "past_due" || s.subscription_status === "canceled") {
    count += 2;
    factors.push("churn_signals");
  }
  if (s.active_users < 1) {
    count += 1;
    factors.push("low_engagement");
  }
  const level: RiskLevel =
    count >= 6 ? "critical" : count >= 4 ? "high" : count >= 2 ? "medium" : "low";
  const churnProbabilityPct = Math.min(95, count * 14);
  return { level, count, churnProbabilityPct, factors };
}
