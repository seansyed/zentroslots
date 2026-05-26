/**
 * Security Mission Control Intelligence — deterministic KPIs + insights
 * powering the /admin/security executive hero strip.
 *
 * Philosophy (consistent with revenue-/finance-/activity-intelligence):
 *   • Every metric is a real SQL query against audit_logs.
 *   • NULL when uncomputable; UI renders "—" rather than fabricated 0.
 *   • No LLM, no ML, no AI-driven actions. Rules engine only.
 *   • Tenant isolation preserved (read-only, cross-tenant ALLOWED for
 *     super-admin operational visibility — the page itself is gated).
 *
 * Hero metrics (8):
 *   • threatLevel               — composite classification (calm/elevated/incident/breach)
 *   • securityPostureScore      — composite 0-100 (NULL at low volume)
 *   • authAnomalyScore          — 0-100 deterministic ratio
 *   • suspiciousActorVelocity   — distinct actors with ≥3 failures/24h
 *   • oauthDegradation          — oauth failures rate %
 *   • impersonationRisk         — count + rate proxy
 *   • activeInvestigations      — multi-IP actors + suspicious IPs union
 *   • adminActions24h           — admin.* + permission.* count
 *
 * Cache: 30s (matches dashboard tier).
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

// ─── Client-safe types (shared with UI) ───────────────────────────

export type SecurityThreatLevel = "calm" | "active" | "elevated" | "incident";

export type SecurityMissionKpis = {
  /** Calm / active / elevated / incident classification. */
  threatLevel: SecurityThreatLevel;
  /** Composite security posture 0-100. NULL at <50 events / <5 active. */
  securityPostureScore: number | null;
  /** 0-100 auth anomaly score (failed/(failed+success) × scaling). NULL at low vol. */
  authAnomalyScore: number | null;
  /** Distinct actors with ≥3 failed logins in 24h. */
  suspiciousActorVelocity: number;
  /** OAuth failures / total OAuth events in 24h. NULL at <10 OAuth events. */
  oauthDegradationPct: number | null;
  /** Impersonation count 7d. */
  impersonations7d: number;
  /** Active investigations = suspicious IPs + multi-IP actors (24h). */
  activeInvestigations: number;
  /** Admin actions in 24h. */
  adminActions24h: number;
  /** Webhook signature failures in 7d. */
  webhookAttacks7d: number;
  /** 12 hourly buckets of failed-login throughput (oldest → newest). */
  authFailureBuckets12h: number[];
  /** 12 hourly buckets of admin-action throughput. */
  adminActionBuckets12h: number[];
  generatedAt: string;
  computedInMs: number;
};

// ─── Hero KPI computation ─────────────────────────────────────────

export async function computeSecurityMissionKpis(): Promise<SecurityMissionKpis> {
  return memoize(
    "admin:security:mission_kpis:v1",
    async () => {
      const t0 = Date.now();

      // Scalar metrics — single round-trip with subselects.
      const row = (await db.execute(
        sql`SELECT
              -- Auth failures last 24h
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE action LIKE 'security.authentication.failed%'
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS auth_failures_24h,
              -- Auth successes last 24h (for ratio)
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE 'security.authentication.success%' OR action LIKE 'auth.login.success%' OR action LIKE 'login.success%')
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS auth_successes_24h,
              -- Distinct suspicious actors (≥3 failed in 24h)
              COALESCE((
                SELECT COUNT(*)::int FROM (
                  SELECT actor_label FROM audit_logs
                   WHERE action LIKE 'security.authentication.failed%'
                     AND actor_label IS NOT NULL
                     AND created_at >= NOW() - INTERVAL '24 hours'
                   GROUP BY actor_label
                  HAVING COUNT(*) >= 3
                ) s
              ), 0) AS suspicious_actors_24h,
              -- OAuth failures + successes 24h
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action ILIKE '%oauth%fail%' OR action ILIKE 'google%fail%' OR action ILIKE 'microsoft%fail%' OR action ILIKE 'calendar.sync.fail%')
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS oauth_failures_24h,
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action ILIKE '%oauth%' OR action ILIKE 'calendar.sync%')
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS oauth_total_24h,
              -- Impersonations 7d
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE action ILIKE '%impersonat%'
                   AND created_at >= NOW() - INTERVAL '7 days'
              ), 0) AS impersonations_7d,
              -- Suspicious IPs (≥5 failures 24h)
              COALESCE((
                SELECT COUNT(*)::int FROM (
                  SELECT ip_address FROM audit_logs
                   WHERE action LIKE 'security.authentication.failed%'
                     AND ip_address IS NOT NULL
                     AND created_at >= NOW() - INTERVAL '24 hours'
                   GROUP BY ip_address
                  HAVING COUNT(*) >= 5
                ) si
              ), 0) AS suspicious_ips_24h,
              -- Multi-IP actors (≥3 IPs 24h)
              COALESCE((
                SELECT COUNT(*)::int FROM (
                  SELECT actor_user_id FROM audit_logs
                   WHERE created_at >= NOW() - INTERVAL '24 hours'
                     AND ip_address IS NOT NULL
                     AND actor_user_id IS NOT NULL
                   GROUP BY actor_user_id
                  HAVING COUNT(DISTINCT ip_address) >= 3
                ) ma
              ), 0) AS multi_ip_actors_24h,
              -- Admin actions 24h
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE (action LIKE 'admin.%' OR action LIKE 'security.permission%')
                   AND created_at >= NOW() - INTERVAL '24 hours'
              ), 0) AS admin_actions_24h,
              -- Webhook attacks 7d
              COALESCE((
                SELECT COUNT(*)::int FROM audit_logs
                 WHERE action = 'stripe_webhook_error'
                   AND created_at >= NOW() - INTERVAL '7 days'
              ), 0) AS webhook_attacks_7d`,
      )) as unknown as Array<{
        auth_failures_24h: number;
        auth_successes_24h: number;
        suspicious_actors_24h: number;
        oauth_failures_24h: number;
        oauth_total_24h: number;
        impersonations_7d: number;
        suspicious_ips_24h: number;
        multi_ip_actors_24h: number;
        admin_actions_24h: number;
        webhook_attacks_7d: number;
      }>;

      const r = row[0] ?? {
        auth_failures_24h: 0,
        auth_successes_24h: 0,
        suspicious_actors_24h: 0,
        oauth_failures_24h: 0,
        oauth_total_24h: 0,
        impersonations_7d: 0,
        suspicious_ips_24h: 0,
        multi_ip_actors_24h: 0,
        admin_actions_24h: 0,
        webhook_attacks_7d: 0,
      };

      const authFailures24h = Number(r.auth_failures_24h);
      const authSuccesses24h = Number(r.auth_successes_24h);
      const suspiciousActorVelocity = Number(r.suspicious_actors_24h);
      const oauthFailures24h = Number(r.oauth_failures_24h);
      const oauthTotal24h = Number(r.oauth_total_24h);
      const impersonations7d = Number(r.impersonations_7d);
      const suspiciousIps = Number(r.suspicious_ips_24h);
      const multiIpActors = Number(r.multi_ip_actors_24h);
      const adminActions24h = Number(r.admin_actions_24h);
      const webhookAttacks7d = Number(r.webhook_attacks_7d);

      // OAuth degradation ratio
      const oauthDegradationPct =
        oauthTotal24h >= 10
          ? Math.round((oauthFailures24h / oauthTotal24h) * 1000) / 10
          : null;

      // Auth anomaly score 0-100
      // Components: failure ratio (0-60) + suspicious-actor velocity (0-40)
      const totalAuth = authFailures24h + authSuccesses24h;
      let authAnomalyScore: number | null = null;
      if (totalAuth >= 20) {
        const failRatio = authFailures24h / Math.max(1, totalAuth);
        const ratioScore = Math.min(60, failRatio * 200);
        const velocityScore = Math.min(40, (suspiciousActorVelocity / 5) * 40);
        authAnomalyScore = Math.round(ratioScore + velocityScore);
      }

      const activeInvestigations = suspiciousIps + multiIpActors;

      // Security posture 0-100. Composite of:
      //   • Auth health (0-30)
      //   • OAuth health (0-25)
      //   • Multi-IP / suspicious IPs absence (0-25)
      //   • Webhook + impersonation hygiene (0-20)
      // NULL when there isn't enough activity to fairly score.
      let securityPostureScore: number | null = null;
      if (totalAuth >= 20 || adminActions24h >= 5) {
        // Auth health: lower = better. 0% failures = 30 pts. 50%+ = 0.
        const failRatio = totalAuth > 0 ? authFailures24h / totalAuth : 0;
        const authHealth = Math.max(0, 30 - failRatio * 60);
        // OAuth health: 0% degradation = 25; 50%+ = 0.
        const oauthHealth =
          oauthDegradationPct !== null
            ? Math.max(0, 25 - oauthDegradationPct / 2)
            : 25;
        // Multi-IP / suspicious IP penalty.
        const ipHealth = Math.max(
          0,
          25 - suspiciousIps * 3 - multiIpActors * 2,
        );
        // Webhook + impersonation hygiene.
        const opsHealth = Math.max(
          0,
          20 - webhookAttacks7d * 1.5 - Math.max(0, impersonations7d - 5),
        );
        securityPostureScore = Math.round(authHealth + oauthHealth + ipHealth + opsHealth);
      }

      // Threat level classifier (deterministic):
      let threatLevel: SecurityThreatLevel = "calm";
      const incidentSignals =
        suspiciousIps >= 3 || multiIpActors >= 5 || authFailures24h >= 100;
      const elevatedSignals =
        suspiciousIps >= 1 ||
        multiIpActors >= 2 ||
        suspiciousActorVelocity >= 3 ||
        (oauthDegradationPct !== null && oauthDegradationPct >= 25);
      const activeSignals =
        authFailures24h >= 10 ||
        (oauthDegradationPct !== null && oauthDegradationPct >= 10) ||
        webhookAttacks7d >= 3 ||
        impersonations7d >= 5;
      if (incidentSignals) threatLevel = "incident";
      else if (elevatedSignals) threatLevel = "elevated";
      else if (activeSignals) threatLevel = "active";

      // 12 hourly buckets — single query, two metrics
      const buckets = (await db.execute(
        sql`SELECT g.bucket,
                   COALESCE(af.cnt, 0)::int AS auth_failures,
                   COALESCE(adm.cnt, 0)::int AS admin_actions
              FROM (SELECT generate_series(0, 11) AS bucket) g
              LEFT JOIN LATERAL (
                SELECT COUNT(*) AS cnt FROM audit_logs
                 WHERE action LIKE 'security.authentication.failed%'
                   AND created_at >= NOW() - ((g.bucket + 1) * INTERVAL '1 hour')
                   AND created_at <  NOW() - (g.bucket * INTERVAL '1 hour')
              ) af ON true
              LEFT JOIN LATERAL (
                SELECT COUNT(*) AS cnt FROM audit_logs
                 WHERE (action LIKE 'admin.%' OR action LIKE 'security.permission%')
                   AND created_at >= NOW() - ((g.bucket + 1) * INTERVAL '1 hour')
                   AND created_at <  NOW() - (g.bucket * INTERVAL '1 hour')
              ) adm ON true
              ORDER BY g.bucket DESC`,
      )) as unknown as Array<{ bucket: number; auth_failures: number; admin_actions: number }>;

      const authFailureBuckets12h = buckets.map((b) => Number(b.auth_failures));
      const adminActionBuckets12h = buckets.map((b) => Number(b.admin_actions));

      return {
        threatLevel,
        securityPostureScore,
        authAnomalyScore,
        suspiciousActorVelocity,
        oauthDegradationPct,
        impersonations7d,
        activeInvestigations,
        adminActions24h,
        webhookAttacks7d,
        authFailureBuckets12h,
        adminActionBuckets12h,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    30_000,
  );
}

// ─── Deterministic insights ───────────────────────────────────────

export type SecurityInsight = {
  id: string;
  surface: "hero" | "auth" | "oauth" | "ip" | "admin";
  tone: "positive" | "neutral" | "warning" | "critical";
  label: string;
  detail?: string;
};

/**
 * Threshold-tested SQL-fact insights. No LLM. Volume-guarded so
 * "Auth failures spiked 400%" doesn't fire because last hour was 1.
 */
export function deriveSecurityInsights(
  kpis: SecurityMissionKpis,
): SecurityInsight[] {
  const out: SecurityInsight[] = [];

  // 1. Auth failure burst (last 2 hourly buckets vs prior 6)
  if (kpis.authFailureBuckets12h.length >= 8) {
    const recent2 = kpis.authFailureBuckets12h.slice(-2).reduce((s, n) => s + n, 0);
    const prior6 = kpis.authFailureBuckets12h.slice(-8, -2).reduce((s, n) => s + n, 0);
    if (recent2 >= 10 && recent2 >= (prior6 / 3) * 2) {
      out.push({
        id: "auth_failure_burst",
        surface: "auth",
        tone: "warning",
        label: `Login failure spike — ${recent2} in last 2h`,
        detail: `Up from average ${Math.round(prior6 / 3)} per 2h window over prior 6 hours.`,
      });
    }
  }

  // 2. OAuth degradation trend
  if (kpis.oauthDegradationPct !== null && kpis.oauthDegradationPct >= 15) {
    out.push({
      id: "oauth_degradation",
      surface: "oauth",
      tone: kpis.oauthDegradationPct >= 30 ? "critical" : "warning",
      label: `OAuth reconnect trend increasing — ${kpis.oauthDegradationPct}% failure rate`,
      detail: "Failed OAuth events / total OAuth events over the last 24 hours.",
    });
  }

  // 3. Impersonation velocity
  if (kpis.impersonations7d >= 10) {
    out.push({
      id: "high_impersonation",
      surface: "admin",
      tone: "warning",
      label: `High impersonation velocity — ${kpis.impersonations7d} in last 7d`,
      detail: "Review impersonation reasons in the permission feed.",
    });
  }

  // 4. Multi-IP repeated pattern
  if (kpis.activeInvestigations >= 3) {
    out.push({
      id: "multi_ip_pattern",
      surface: "ip",
      tone: kpis.activeInvestigations >= 8 ? "critical" : "warning",
      label: `Repeated multi-IP access pattern — ${kpis.activeInvestigations} investigations open`,
      detail: "Combines suspicious IPs (≥5 fails) and multi-IP actors (≥3 distinct IPs) in 24h.",
    });
  }

  // 5. Threat level elevation hero notice
  if (kpis.threatLevel === "incident") {
    out.push({
      id: "threat_incident",
      surface: "hero",
      tone: "critical",
      label: "Incident-tier threat signals detected — investigate immediately",
      detail: "≥3 suspicious IPs · ≥5 multi-IP actors · or ≥100 failed logins in 24h.",
    });
  } else if (kpis.threatLevel === "elevated") {
    out.push({
      id: "threat_elevated",
      surface: "hero",
      tone: "warning",
      label: "Elevated security signals — review investigations queue",
      detail: "Composite of suspicious actor velocity, multi-IP clustering, and OAuth health.",
    });
  } else if (
    kpis.threatLevel === "calm" &&
    kpis.securityPostureScore !== null &&
    kpis.securityPostureScore >= 85
  ) {
    out.push({
      id: "posture_healthy",
      surface: "hero",
      tone: "positive",
      label: `Security posture healthy — score ${kpis.securityPostureScore}`,
      detail: "Auth health + OAuth health + IP hygiene + ops hygiene composite.",
    });
  }

  // 6. Suspicious actor distribution
  if (kpis.suspiciousActorVelocity >= 5) {
    out.push({
      id: "suspicious_actor_distribution",
      surface: "auth",
      tone: "warning",
      label: `Unusual actor distribution — ${kpis.suspiciousActorVelocity} actors with ≥3 failures`,
      detail: "Investigate via the IP intelligence + permission tracking surfaces.",
    });
  }

  // 7. Admin action burst
  if (kpis.adminActionBuckets12h.length >= 8) {
    const recent2 = kpis.adminActionBuckets12h.slice(-2).reduce((s, n) => s + n, 0);
    const prior6 = kpis.adminActionBuckets12h.slice(-8, -2).reduce((s, n) => s + n, 0);
    if (recent2 >= 20 && recent2 >= (prior6 / 3) * 2) {
      out.push({
        id: "admin_action_burst",
        surface: "admin",
        tone: "neutral",
        label: `Admin action burst — ${recent2} in last 2h`,
        detail: `Up from average ${Math.round(prior6 / 3)} per 2h window. Confirm intended.`,
      });
    }
  }

  return out;
}
