/**
 * Activity Mission Control — deterministic KPIs + throughput series
 * for the /admin/activity executive hero strip.
 *
 * Philosophy (consistent with revenue-/finance-intelligence):
 *   • Every metric is a real SQL query against audit_logs.
 *   • NULL when uncomputable; UI renders "—" never a fake 0%.
 *   • No LLM, no ML, no heuristics that fabricate values.
 *
 * Hero metrics:
 *   • activeIncidents24h    — count of critical+warning events 24h
 *   • warnings24h           — warning-only count 24h
 *   • authFailures24h       — login_failure + suspicious_activity 24h
 *   • oauthFailures24h      — oauth_failed + oauth_token_expired 24h
 *   • webhookFailures24h    — webhook_failed 24h
 *   • impersonations24h    — impersonation_started 24h
 *   • billingFailures24h    — payment_failed 24h
 *   • throughputPerHour     — events/hr, last hour
 *   • anomalyScore          — composite 0-100, NULL at low volume
 *   • throughput12h         — 12-bucket sparkline series (hourly buckets)
 *   • streamHealth          — derived classification: "calm" / "active" /
 *                              "elevated" / "incident"
 *
 * Cache: 30s (matches the live-poll cadence).
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

// Re-export shared types + constants for backward compatibility.
export {
  ACTIVITY_PRESETS,
  KIND_CATEGORY,
  type ActivityPreset,
  type ActivityCategory,
  type ActivityStreamHealth,
  type ActivityMissionKpis,
} from "./activity-presets";

import type { ActivityMissionKpis, ActivityStreamHealth } from "./activity-presets";

export async function computeActivityMissionKpis(): Promise<ActivityMissionKpis> {
  return memoize(
    "admin:activity:mission_kpis:v1",
    async () => {
      const t0 = Date.now();

      // Scalar metrics in a single round-trip.
      const row = (await db.execute(
        sql`SELECT
              -- Authentication
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE 'auth.login.fail%' OR action LIKE 'login.fail%')
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS auth_failures_24h,
              -- OAuth
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE 'oauth.fail%' OR action LIKE 'oauth.token.expire%' OR action LIKE 'calendar.sync.fail%')
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS oauth_failures_24h,
              -- Webhooks
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE 'webhook.fail%' OR action LIKE 'webhook.delivery.fail%')
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS webhook_failures_24h,
              -- Impersonations
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE action LIKE 'admin.impersonation%'
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS impersonations_24h,
              -- Billing
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE '%payment.fail%' OR action LIKE 'billing.invoice.fail%' OR action LIKE 'stripe.charge.fail%')
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS billing_failures_24h,
              -- Warnings vs criticals: we don't store severity in audit_logs
              -- so we map kind → severity here. Counts approximate but stable.
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (
                       action LIKE '%fail%'
                    OR action LIKE '%error%'
                    OR action LIKE '%suspend%'
                    OR action LIKE '%suspicious%'
                 )
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS warning_or_critical_24h,
              -- Throughput: events/hr trailing hour + 24h baseline.
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE created_at >= NOW() - INTERVAL '1 hour'
              ), 0) AS events_last_hour,
              COALESCE((
                SELECT ROUND(COUNT(*)::numeric / 24)::int FROM audit_logs
                 WHERE created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS baseline_events_per_hour`,
      )) as unknown as Array<{
        auth_failures_24h: number;
        oauth_failures_24h: number;
        webhook_failures_24h: number;
        impersonations_24h: number;
        billing_failures_24h: number;
        warning_or_critical_24h: number;
        events_last_hour: number;
        baseline_events_per_hour: number;
      }>;

      const r = row[0] ?? {
        auth_failures_24h: 0,
        oauth_failures_24h: 0,
        webhook_failures_24h: 0,
        impersonations_24h: 0,
        billing_failures_24h: 0,
        warning_or_critical_24h: 0,
        events_last_hour: 0,
        baseline_events_per_hour: 0,
      };

      const authFailures24h = Number(r.auth_failures_24h);
      const oauthFailures24h = Number(r.oauth_failures_24h);
      const webhookFailures24h = Number(r.webhook_failures_24h);
      const impersonations24h = Number(r.impersonations_24h);
      const billingFailures24h = Number(r.billing_failures_24h);
      const eventsLastHour = Number(r.events_last_hour);
      const baselineEventsPerHour = Number(r.baseline_events_per_hour);

      // Active incidents = the union of failure-style events. We split
      // into warnings vs activeIncidents at the UI surface, but the
      // total is the warning_or_critical_24h count.
      const activeIncidents24h = Number(r.warning_or_critical_24h);
      const warnings24h = Math.max(
        0,
        activeIncidents24h -
          (authFailures24h + oauthFailures24h + webhookFailures24h + billingFailures24h),
      );

      // Throughput buckets — 12 hourly buckets (oldest → newest).
      const buckets = (await db.execute(
        sql`SELECT bucket, COALESCE(total, 0)::int AS total, COALESCE(criticals, 0)::int AS criticals
              FROM (
                SELECT generate_series(0, 11) AS bucket
              ) g
              LEFT JOIN LATERAL (
                SELECT
                  COUNT(*) AS total,
                  COUNT(*) FILTER (
                    WHERE action LIKE '%fail%'
                       OR action LIKE '%error%'
                       OR action LIKE '%suspend%'
                       OR action LIKE '%suspicious%'
                  ) AS criticals
                FROM audit_logs
                WHERE created_at >= NOW() - ((g.bucket + 1) * INTERVAL '1 hour')
                  AND created_at <  NOW() - (g.bucket * INTERVAL '1 hour')
              ) bk ON true
              ORDER BY bucket DESC`,
      )) as unknown as Array<{ bucket: number; total: number; criticals: number }>;

      // Reverse so it's oldest → newest for sparkline rendering.
      const throughput12h = buckets.map((b) => Number(b.total));
      const severityPulse12h = buckets.map((b) => Number(b.criticals));

      // Anomaly score 0-100. Composite:
      //  • throughput delta vs baseline (0–40)
      //  • critical event ratio (0–30)
      //  • auth+oauth pressure (0–30)
      // Returns NULL when we don't have enough volume to be honest.
      let anomalyScore: number | null = null;
      const totalVolume24h = throughput12h.reduce((s, n) => s + n, 0) * 2; // approx 24h via 12 buckets × 2
      if (totalVolume24h >= 50 && baselineEventsPerHour > 0) {
        const throughputDelta = Math.max(0, eventsLastHour / Math.max(1, baselineEventsPerHour) - 1);
        const throughputScore = Math.min(40, throughputDelta * 40);
        const critRatio =
          activeIncidents24h > 0 ? activeIncidents24h / Math.max(1, totalVolume24h) : 0;
        const critScore = Math.min(30, critRatio * 100);
        const authPressure = Math.min(30, ((authFailures24h + oauthFailures24h) / 20) * 30);
        anomalyScore = Math.round(throughputScore + critScore + authPressure);
      }

      // Stream health classification.
      let streamHealth: ActivityStreamHealth;
      const criticalAttack =
        authFailures24h >= 20 || webhookFailures24h >= 10 || billingFailures24h >= 5;
      if (criticalAttack || (anomalyScore !== null && anomalyScore >= 70)) {
        streamHealth = "incident";
      } else if (anomalyScore !== null && anomalyScore >= 40) {
        streamHealth = "elevated";
      } else if (eventsLastHour >= Math.max(20, baselineEventsPerHour * 1.5)) {
        streamHealth = "active";
      } else {
        streamHealth = "calm";
      }

      return {
        activeIncidents24h,
        warnings24h,
        authFailures24h,
        oauthFailures24h,
        webhookFailures24h,
        impersonations24h,
        billingFailures24h,
        eventsLastHour,
        baselineEventsPerHour,
        anomalyScore,
        streamHealth,
        throughput12h,
        severityPulse12h,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    30_000,
  );
}

// Presets + category map live in ./activity-presets (client-safe, no DB).
