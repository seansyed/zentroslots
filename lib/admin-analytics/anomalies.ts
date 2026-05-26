/**
 * SA-5 — Deterministic anomaly detection.
 *
 * NO AI, NO ML, NO HALLUCINATIONS. Pure SQL rules engine.
 *
 * Each anomaly compares a current short window (default 1h or 24h)
 * against a baseline window (prior 24h or 7d). When the current
 * window's metric exceeds a fixed multiplier of the baseline, the
 * anomaly fires.
 *
 * Anomalies surfaced:
 *   • booking_spike            bookings 1h ≥ 3× hourly-avg over 7d
 *   • reminder_failure_spike   failed reminders 1h ≥ 5 AND > 3× baseline
 *   • payment_failure_spike    failed payments 24h ≥ 3× prior-24h
 *   • webhook_failure_burst    webhook failures 1h ≥ 5 AND > 3× baseline
 *   • unusual_login_activity   failed logins 24h ≥ 20 OR ≥ 4× prior 24h
 *   • abnormal_churn           churn events 24h ≥ 3× prior-7d-daily-avg
 *
 * All values from real DB queries. Each rule is wrapped in safe()
 * so a single failure cannot block the others.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

export type AnomalyKind =
  | "booking_spike"
  | "reminder_failure_spike"
  | "payment_failure_spike"
  | "webhook_failure_burst"
  | "unusual_login_activity"
  | "abnormal_churn";

export type Anomaly = {
  kind: AnomalyKind;
  label: string;
  severity: "info" | "warning" | "critical";
  /** Numeric metric that triggered the rule. */
  current: number;
  /** Baseline value compared against. */
  baseline: number;
  /** Multiplier observed (current / baseline). */
  ratio: number | null;
  /** Human-readable explanation. */
  detail: string;
  /** Window key (e.g. "1h", "24h"). */
  window: string;
  triggeredAt: string;
};

export type AnomalyReport = {
  anomalies: Anomaly[];
  generatedAt: string;
  computedInMs: number;
};

async function safeRow<T extends Record<string, unknown>>(
  query: ReturnType<typeof sql>,
  fallback: T,
): Promise<T> {
  try {
    const rows = (await db.execute(query)) as unknown as T[];
    return rows[0] ?? fallback;
  } catch {
    return fallback;
  }
}

function ratio(current: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return Math.round((current / baseline) * 10) / 10;
}

// ─── Detection rules ──────────────────────────────────────────────

async function checkBookingSpike(): Promise<Anomaly | null> {
  const r = await safeRow(
    sql`SELECT
          (SELECT COUNT(*)::int FROM bookings WHERE created_at > NOW() - INTERVAL '1 hour') AS curr_1h,
          (SELECT COUNT(*)::float8 FROM bookings WHERE created_at > NOW() - INTERVAL '7 days' AND created_at < NOW() - INTERVAL '1 hour') / 168.0 AS hourly_avg_7d`,
    { curr_1h: 0, hourly_avg_7d: 0 },
  );
  const curr = Number(r.curr_1h);
  const baseline = Number(r.hourly_avg_7d);
  if (curr < 5) return null; // Don't flag low-volume tenants
  if (baseline === 0) return null;
  const rr = curr / baseline;
  if (rr < 3) return null;
  return {
    kind: "booking_spike",
    label: "Booking spike",
    severity: rr >= 5 ? "warning" : "info",
    current: curr,
    baseline: Math.round(baseline * 10) / 10,
    ratio: Math.round(rr * 10) / 10,
    detail: `${curr} bookings in the last hour vs ${baseline.toFixed(1)}/hr 7-day average.`,
    window: "1h",
    triggeredAt: new Date().toISOString(),
  };
}

async function checkReminderFailureSpike(): Promise<Anomaly | null> {
  const r = await safeRow(
    sql`SELECT
          (SELECT COUNT(*)::int FROM communication_logs WHERE status='failed' AND created_at > NOW() - INTERVAL '1 hour') AS curr_1h,
          (SELECT COUNT(*)::float8 FROM communication_logs WHERE status='failed' AND created_at > NOW() - INTERVAL '7 days' AND created_at < NOW() - INTERVAL '1 hour') / 168.0 AS hourly_avg_7d`,
    { curr_1h: 0, hourly_avg_7d: 0 },
  );
  const curr = Number(r.curr_1h);
  if (curr < 5) return null;
  const baseline = Number(r.hourly_avg_7d);
  const rr = ratio(curr, baseline);
  if (baseline > 0 && rr !== null && rr < 3) return null;
  return {
    kind: "reminder_failure_spike",
    label: "Reminder failure spike",
    severity: curr >= 25 ? "critical" : "warning",
    current: curr,
    baseline: Math.round(baseline * 10) / 10,
    ratio: rr,
    detail: `${curr} failed reminder send${curr === 1 ? "" : "s"} in the last hour vs ${baseline.toFixed(1)}/hr 7-day average. Check SES sandbox + sender identity.`,
    window: "1h",
    triggeredAt: new Date().toISOString(),
  };
}

async function checkPaymentFailureSpike(): Promise<Anomaly | null> {
  const r = await safeRow(
    sql`SELECT
          (SELECT COUNT(*)::int FROM billing_transactions WHERE status='failed' AND created_at > NOW() - INTERVAL '24 hours') AS curr_24h,
          (SELECT COUNT(*)::int FROM billing_transactions WHERE status='failed' AND created_at > NOW() - INTERVAL '48 hours' AND created_at < NOW() - INTERVAL '24 hours') AS prev_24h`,
    { curr_24h: 0, prev_24h: 0 },
  );
  const curr = Number(r.curr_24h);
  const prev = Number(r.prev_24h);
  if (curr < 3) return null;
  const rr = ratio(curr, prev);
  if (prev > 0 && rr !== null && rr < 3) return null;
  return {
    kind: "payment_failure_spike",
    label: "Payment failure spike",
    severity: curr >= 10 ? "critical" : "warning",
    current: curr,
    baseline: prev,
    ratio: rr,
    detail: `${curr} failed Stripe charges in last 24h vs ${prev} in prior 24h.`,
    window: "24h",
    triggeredAt: new Date().toISOString(),
  };
}

async function checkWebhookFailureBurst(): Promise<Anomaly | null> {
  const r = await safeRow(
    sql`SELECT
          (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE '%webhook%fail%' AND created_at > NOW() - INTERVAL '1 hour') AS curr_1h,
          (SELECT COUNT(*)::float8 FROM audit_logs WHERE action LIKE '%webhook%fail%' AND created_at > NOW() - INTERVAL '7 days' AND created_at < NOW() - INTERVAL '1 hour') / 168.0 AS hourly_avg_7d`,
    { curr_1h: 0, hourly_avg_7d: 0 },
  );
  const curr = Number(r.curr_1h);
  if (curr < 5) return null;
  const baseline = Number(r.hourly_avg_7d);
  const rr = ratio(curr, baseline);
  if (baseline > 0 && rr !== null && rr < 3) return null;
  return {
    kind: "webhook_failure_burst",
    label: "Webhook failure burst",
    severity: curr >= 20 ? "critical" : "warning",
    current: curr,
    baseline: Math.round(baseline * 10) / 10,
    ratio: rr,
    detail: `${curr} webhook failure${curr === 1 ? "" : "s"} in last hour vs ${baseline.toFixed(1)}/hr 7-day average.`,
    window: "1h",
    triggeredAt: new Date().toISOString(),
  };
}

async function checkUnusualLoginActivity(): Promise<Anomaly | null> {
  const r = await safeRow(
    sql`SELECT
          (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'security.authentication.failed%' AND created_at > NOW() - INTERVAL '24 hours') AS curr_24h,
          (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE 'security.authentication.failed%' AND created_at > NOW() - INTERVAL '48 hours' AND created_at < NOW() - INTERVAL '24 hours') AS prev_24h`,
    { curr_24h: 0, prev_24h: 0 },
  );
  const curr = Number(r.curr_24h);
  if (curr < 20) {
    // Also check 4x prior — if prior was tiny and current spiked
    const prev = Number(r.prev_24h);
    const rr = ratio(curr, prev);
    if (curr >= 10 && prev > 0 && rr !== null && rr >= 4) {
      return {
        kind: "unusual_login_activity",
        label: "Unusual login activity",
        severity: "warning",
        current: curr,
        baseline: prev,
        ratio: rr,
        detail: `${curr} failed login attempts in last 24h vs ${prev} prior — credential-spray candidate.`,
        window: "24h",
        triggeredAt: new Date().toISOString(),
      };
    }
    return null;
  }
  return {
    kind: "unusual_login_activity",
    label: "Unusual login activity",
    severity: curr >= 100 ? "critical" : "warning",
    current: curr,
    baseline: Number(r.prev_24h),
    ratio: ratio(curr, Number(r.prev_24h)),
    detail: `${curr} failed login attempts in last 24h — review IP audit log for cluster.`,
    window: "24h",
    triggeredAt: new Date().toISOString(),
  };
}

async function checkAbnormalChurn(): Promise<Anomaly | null> {
  const r = await safeRow(
    sql`SELECT
          (SELECT COUNT(*)::int FROM audit_logs WHERE (action LIKE '%subscription.cancel%' OR action LIKE 'billing.downgrade%') AND created_at > NOW() - INTERVAL '24 hours') AS curr_24h,
          (SELECT COUNT(*)::float8 FROM audit_logs WHERE (action LIKE '%subscription.cancel%' OR action LIKE 'billing.downgrade%') AND created_at > NOW() - INTERVAL '7 days' AND created_at < NOW() - INTERVAL '24 hours') / 6.0 AS daily_avg_prev_6d`,
    { curr_24h: 0, daily_avg_prev_6d: 0 },
  );
  const curr = Number(r.curr_24h);
  if (curr < 2) return null;
  const baseline = Number(r.daily_avg_prev_6d);
  const rr = ratio(curr, baseline);
  if (baseline > 0 && rr !== null && rr < 3) return null;
  return {
    kind: "abnormal_churn",
    label: "Abnormal churn",
    severity: curr >= 5 ? "warning" : "info",
    current: curr,
    baseline: Math.round(baseline * 10) / 10,
    ratio: rr,
    detail: `${curr} cancellation/downgrade event${curr === 1 ? "" : "s"} in last 24h vs ${baseline.toFixed(1)}/day 6-day average.`,
    window: "24h",
    triggeredAt: new Date().toISOString(),
  };
}

// ─── Orchestrator ─────────────────────────────────────────────────

export async function computeAnomalies(): Promise<AnomalyReport> {
  return memoize(
    "admin:anomalies:v1",
    async () => {
      const t0 = Date.now();
      const checks = await Promise.all([
        checkBookingSpike().catch(() => null),
        checkReminderFailureSpike().catch(() => null),
        checkPaymentFailureSpike().catch(() => null),
        checkWebhookFailureBurst().catch(() => null),
        checkUnusualLoginActivity().catch(() => null),
        checkAbnormalChurn().catch(() => null),
      ]);
      const anomalies = checks.filter((a): a is Anomaly => a !== null);
      // Sort: critical first, then warning, then info.
      const sevOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
      anomalies.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
      return {
        anomalies,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    60_000,
  );
}
