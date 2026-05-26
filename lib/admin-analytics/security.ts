/**
 * SA-7 — Security & Audit Operations Center analytics.
 *
 * Five sections, all cross-tenant, all from real audit_logs + auth
 * tables. NO mock data. Each compute wrapped in safe() so a single
 * failure becomes an inline error chip on its card.
 *
 *   §A: Security KPI grid (11 cards)
 *   §B: Audit Explorer query (paginated; reuses activity classifier
 *       infrastructure but exposes raw audit rows, not classified)
 *   §C: Security event feed (subset of activity-classifier kinds)
 *   §D: IP Intelligence (top suspicious IPs, repeated failures,
 *       admin access locations, impossible-travel detection)
 *   §E: Permission & admin tracking (role changes, impersonation,
 *       bulk admin actions, financial actions)
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { memoize } from "./cache";

// ─── Shared shapes ──────────────────────────────────────────────────

export type SecurityKpiCard = {
  key: string;
  label: string;
  value: number | null;
  unit: "count" | "percent";
  status: "green" | "amber" | "red";
  trendPct: number | null;
  sparkline: number[];
  detail: string;
  tooltip: string;
  error?: string;
};

export type SecurityKpiBundle = {
  cards: SecurityKpiCard[];
  generatedAt: string;
  computedInMs: number;
};

// ─── Helpers ───────────────────────────────────────────────────────

function pctDelta(curr: number | null, prev: number | null): number | null {
  if (curr === null || prev === null || prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

function pickStatus(value: number | null, amber: number, red: number): "green" | "amber" | "red" {
  if (value === null) return "amber";
  if (value >= red) return "red";
  if (value >= amber) return "amber";
  return "green";
}

async function safe(producer: () => Promise<SecurityKpiCard>, fallback: SecurityKpiCard): Promise<SecurityKpiCard> {
  try {
    return await producer();
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : "unknown";
    try {
      console.error(JSON.stringify({ evt: "security_kpi_fail", reason }));
    } catch {}
    return { ...fallback, error: reason };
  }
}

async function pairCount(actionLike: string, window: "24 hours" | "7 days"): Promise<{ curr: number; prev: number }> {
  const rows = (await db.execute(
    sql`SELECT
          (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE ${actionLike} AND created_at > NOW() - INTERVAL ${sql.raw(`'${window}'`)}) AS curr,
          (SELECT COUNT(*)::int FROM audit_logs WHERE action LIKE ${actionLike} AND created_at > NOW() - INTERVAL ${sql.raw(`'${window === "24 hours" ? "48 hours" : "14 days"}'`)} AND created_at < NOW() - INTERVAL ${sql.raw(`'${window}'`)}) AS prev`,
  )) as unknown as Array<{ curr: number; prev: number }>;
  return { curr: Number(rows[0]?.curr ?? 0), prev: Number(rows[0]?.prev ?? 0) };
}

// ─── §A: KPI cards ─────────────────────────────────────────────────

export async function computeSecurityKpis(): Promise<SecurityKpiBundle> {
  return memoize(
    "admin:security:kpis:v1",
    async () => {
      const t0 = Date.now();
      const cards = await Promise.all([
        // Failed logins (24h)
        safe(
          async () => {
            const p = await pairCount("security.authentication.failed%", "24 hours");
            return {
              key: "failed_logins_24h",
              label: "Failed logins (24h)",
              value: p.curr,
              unit: "count",
              status: pickStatus(p.curr, 20, 100),
              trendPct: pctDelta(p.curr, p.prev),
              sparkline: [],
              detail: p.curr === 0 ? "No failures" : `${p.curr} attempt${p.curr === 1 ? "" : "s"}`,
              tooltip: "audit_logs action LIKE 'security.authentication.failed%' in last 24h.",
            };
          },
          { key: "failed_logins_24h", label: "Failed logins (24h)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Suspicious activity count
        safe(
          async () => {
            const p = await pairCount("security.suspicious%", "24 hours");
            return {
              key: "suspicious_activity",
              label: "Suspicious activity (24h)",
              value: p.curr,
              unit: "count",
              status: pickStatus(p.curr, 1, 5),
              trendPct: pctDelta(p.curr, p.prev),
              sparkline: [],
              detail: p.curr === 0 ? "Clean" : "Investigate",
              tooltip: "audit_logs action LIKE 'security.suspicious%' in last 24h.",
            };
          },
          { key: "suspicious_activity", label: "Suspicious activity (24h)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Impersonation sessions
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT COUNT(*)::int AS curr,
                         (SELECT COUNT(*)::int FROM audit_logs WHERE action ILIKE '%impersonat%' AND created_at > NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days') AS prev
                    FROM audit_logs WHERE action ILIKE '%impersonat%' AND created_at > NOW() - INTERVAL '7 days'`,
            )) as unknown as Array<{ curr: number; prev: number }>;
            const curr = Number(rows[0]?.curr ?? 0);
            const prev = Number(rows[0]?.prev ?? 0);
            return {
              key: "impersonation_sessions",
              label: "Impersonations (7d)",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 5, 20),
              trendPct: pctDelta(curr, prev),
              sparkline: [],
              detail: curr === 0 ? "None" : `${curr} session${curr === 1 ? "" : "s"}`,
              tooltip: "audit_logs action ILIKE '%impersonat%' in last 7 days. Useful for understanding ops involvement.",
            };
          },
          { key: "impersonation_sessions", label: "Impersonations (7d)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Rate-limit violations
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT COUNT(*)::int AS curr,
                         (SELECT COUNT(*)::int FROM audit_logs WHERE (action ILIKE '%rate_limit%' OR action ILIKE '%429%') AND created_at > NOW() - INTERVAL '48 hours' AND created_at < NOW() - INTERVAL '24 hours') AS prev
                    FROM audit_logs WHERE (action ILIKE '%rate_limit%' OR action ILIKE '%429%') AND created_at > NOW() - INTERVAL '24 hours'`,
            )) as unknown as Array<{ curr: number; prev: number }>;
            const curr = Number(rows[0]?.curr ?? 0);
            const prev = Number(rows[0]?.prev ?? 0);
            return {
              key: "rate_limit_violations",
              label: "Rate-limit hits (24h)",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 10, 100),
              trendPct: pctDelta(curr, prev),
              sparkline: [],
              detail: curr === 0 ? "Clean" : `${curr}`,
              tooltip: "audit_logs action ILIKE '%rate_limit%' OR '%429%' in last 24h.",
            };
          },
          { key: "rate_limit_violations", label: "Rate-limit hits (24h)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // OAuth failures
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT COUNT(*)::int AS curr,
                         (SELECT COUNT(*)::int FROM audit_logs WHERE (action ILIKE '%oauth%fail%' OR action ILIKE 'google%fail%' OR action ILIKE 'microsoft%fail%') AND created_at > NOW() - INTERVAL '48 hours' AND created_at < NOW() - INTERVAL '24 hours') AS prev
                    FROM audit_logs WHERE (action ILIKE '%oauth%fail%' OR action ILIKE 'google%fail%' OR action ILIKE 'microsoft%fail%') AND created_at > NOW() - INTERVAL '24 hours'`,
            )) as unknown as Array<{ curr: number; prev: number }>;
            const curr = Number(rows[0]?.curr ?? 0);
            const prev = Number(rows[0]?.prev ?? 0);
            return {
              key: "oauth_failures",
              label: "OAuth failures (24h)",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 5, 20),
              trendPct: pctDelta(curr, prev),
              sparkline: [],
              detail: curr === 0 ? "Clean" : "Review",
              tooltip: "Failed OAuth refresh/exchange events in last 24h.",
            };
          },
          { key: "oauth_failures", label: "OAuth failures (24h)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Expired tokens (active count from users + calendar_connections)
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT
                    (SELECT COUNT(*)::int FROM users WHERE google_refresh_token IS NOT NULL AND google_status IN ('expired','error')) +
                    (SELECT COUNT(*)::int FROM calendar_connections WHERE provider='microsoft' AND status IN ('needs_reconnect','expired','error')) AS curr`,
            )) as unknown as Array<{ curr: number }>;
            const curr = Number(rows[0]?.curr ?? 0);
            return {
              key: "expired_tokens",
              label: "Expired tokens",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 1, 10),
              trendPct: null,
              sparkline: [],
              detail: curr === 0 ? "All healthy" : `${curr} need reconnect`,
              tooltip: "Google + Microsoft refresh tokens with status='expired' or 'error' (snapshot).",
            };
          },
          { key: "expired_tokens", label: "Expired tokens", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Webhook attacks blocked (signature failures)
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT COUNT(*)::int AS curr,
                         (SELECT COUNT(*)::int FROM audit_logs WHERE action = 'stripe_webhook_error' AND created_at > NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days') AS prev
                    FROM audit_logs WHERE action = 'stripe_webhook_error' AND created_at > NOW() - INTERVAL '7 days'`,
            )) as unknown as Array<{ curr: number; prev: number }>;
            const curr = Number(rows[0]?.curr ?? 0);
            const prev = Number(rows[0]?.prev ?? 0);
            return {
              key: "webhook_attacks_blocked",
              label: "Webhook attacks blocked (7d)",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 5, 25),
              trendPct: pctDelta(curr, prev),
              sparkline: [],
              detail: curr === 0 ? "Clean" : "Signature mismatches",
              tooltip: "Stripe webhook signature verification failures — admin-notify alerts on these. Each row = one blocked attempt.",
            };
          },
          { key: "webhook_attacks_blocked", label: "Webhook attacks blocked (7d)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Admin actions (24h)
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT COUNT(*)::int AS curr,
                         (SELECT COUNT(*)::int FROM audit_logs WHERE (action LIKE 'admin.%' OR action LIKE 'security.permission%') AND created_at > NOW() - INTERVAL '48 hours' AND created_at < NOW() - INTERVAL '24 hours') AS prev
                    FROM audit_logs WHERE (action LIKE 'admin.%' OR action LIKE 'security.permission%') AND created_at > NOW() - INTERVAL '24 hours'`,
            )) as unknown as Array<{ curr: number; prev: number }>;
            const curr = Number(rows[0]?.curr ?? 0);
            const prev = Number(rows[0]?.prev ?? 0);
            return {
              key: "admin_actions_24h",
              label: "Admin actions (24h)",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 50, 200),
              trendPct: pctDelta(curr, prev),
              sparkline: [],
              detail: `${curr}`,
              tooltip: "audit_logs admin.* OR security.permission.* in last 24h.",
            };
          },
          { key: "admin_actions_24h", label: "Admin actions (24h)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Critical audit events (any worker_crash, cron.fail, fatal_exception)
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT COUNT(*)::int AS curr
                    FROM audit_logs
                   WHERE (action LIKE '%worker.crash%' OR action LIKE '%cron.fail%' OR action LIKE '%fatal_exception%' OR action = 'worker_crash')
                     AND created_at > NOW() - INTERVAL '24 hours'`,
            )) as unknown as Array<{ curr: number }>;
            const curr = Number(rows[0]?.curr ?? 0);
            return {
              key: "critical_audit_events",
              label: "Critical events (24h)",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 1, 5),
              trendPct: null,
              sparkline: [],
              detail: curr === 0 ? "Clean" : "Worker crashes",
              tooltip: "Worker / cron crashes and fatal exceptions in last 24h.",
            };
          },
          { key: "critical_audit_events", label: "Critical events (24h)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Tenant suspensions
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT COUNT(*)::int AS curr,
                         (SELECT COUNT(*)::int FROM audit_logs WHERE (action LIKE '%suspend%' OR action = 'admin.bulk.suspend') AND created_at > NOW() - INTERVAL '14 days' AND created_at < NOW() - INTERVAL '7 days') AS prev
                    FROM audit_logs WHERE (action LIKE '%suspend%' OR action = 'admin.bulk.suspend') AND created_at > NOW() - INTERVAL '7 days'`,
            )) as unknown as Array<{ curr: number; prev: number }>;
            const curr = Number(rows[0]?.curr ?? 0);
            const prev = Number(rows[0]?.prev ?? 0);
            return {
              key: "tenant_suspensions",
              label: "Tenant suspensions (7d)",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 2, 10),
              trendPct: pctDelta(curr, prev),
              sparkline: [],
              detail: curr === 0 ? "None" : `${curr}`,
              tooltip: "Bulk admin or auto suspension events in last 7 days.",
            };
          },
          { key: "tenant_suspensions", label: "Tenant suspensions (7d)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),

        // Geographic anomalies — proxy: distinct IPs per actor in last 24h
        safe(
          async () => {
            const rows = (await db.execute(
              sql`SELECT COUNT(*)::int AS n
                    FROM (
                      SELECT actor_user_id
                        FROM audit_logs
                       WHERE created_at > NOW() - INTERVAL '24 hours'
                         AND ip_address IS NOT NULL
                         AND actor_user_id IS NOT NULL
                       GROUP BY actor_user_id
                      HAVING COUNT(DISTINCT ip_address) >= 3
                    ) x`,
            )) as unknown as Array<{ n: number }>;
            const curr = Number(rows[0]?.n ?? 0);
            return {
              key: "geo_anomalies",
              label: "Multi-IP actors (24h)",
              value: curr,
              unit: "count",
              status: pickStatus(curr, 1, 5),
              trendPct: null,
              sparkline: [],
              detail: curr === 0 ? "None" : `${curr} actor${curr === 1 ? "" : "s"}`,
              tooltip:
                "Distinct users who hit ≥3 unique IPs in last 24h. Without GeoIP this is a coarse proxy — clusters of three+ IPs from one user typically indicate either a VPN/proxy hop or credential sharing. Investigate manually.",
            };
          },
          { key: "geo_anomalies", label: "Multi-IP actors (24h)", value: null, unit: "count", status: "amber", trendPct: null, sparkline: [], detail: "—", tooltip: "" },
        ),
      ]);

      return {
        cards,
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    60_000,
  );
}

// ─── §B / §C: Audit explorer (full audit row passthrough) ─────────

export type AuditRow = {
  id: string;
  ts: string;
  action: string;
  actor: string | null;
  tenantId: string | null;
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
};

export type AuditPage = {
  rows: AuditRow[];
  nextCursor: string | null;
};

export async function fetchAuditRows(args: {
  cursor?: string | null;
  limit?: number;
  /** Substring match on action (case-insensitive). */
  action?: string | null;
  /** Substring match on actor label / email (case-insensitive). */
  actor?: string | null;
  /** Exact tenant id. */
  tenantId?: string | null;
  /** Substring match on ip. */
  ip?: string | null;
  /** ISO inclusive. */
  since?: string | null;
  /** ISO exclusive. */
  until?: string | null;
}): Promise<AuditPage> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const cursor = args.cursor ?? null;
  const action = args.action ? `%${args.action}%` : null;
  const actor = args.actor ? `%${args.actor}%` : null;
  const tenantId = args.tenantId ?? null;
  const ip = args.ip ? `%${args.ip}%` : null;
  const since = args.since ?? null;
  const until = args.until ?? null;

  const rows = (await db.execute(
    sql`SELECT id::text AS id, action, actor_label, tenant_id::text AS tenant_id,
               entity_type, entity_id::text AS entity_id, ip_address, metadata, created_at
          FROM audit_logs
         WHERE (${cursor}::text IS NULL OR created_at < ${cursor}::timestamptz)
           AND (${action}::text IS NULL OR action ILIKE ${action}::text)
           AND (${actor}::text IS NULL OR COALESCE(actor_label, '') ILIKE ${actor}::text)
           AND (${tenantId}::text IS NULL OR tenant_id = ${tenantId}::uuid)
           AND (${ip}::text IS NULL OR COALESCE(ip_address, '') ILIKE ${ip}::text)
           AND (${since}::text IS NULL OR created_at >= ${since}::timestamptz)
           AND (${until}::text IS NULL OR created_at <  ${until}::timestamptz)
         ORDER BY created_at DESC
         LIMIT ${limit}`,
  )) as unknown as Array<{
    id: string;
    action: string;
    actor_label: string | null;
    tenant_id: string | null;
    entity_type: string | null;
    entity_id: string | null;
    ip_address: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;

  return {
    rows: rows.map((r) => ({
      id: r.id,
      ts: r.created_at,
      action: r.action,
      actor: r.actor_label,
      tenantId: r.tenant_id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      ipAddress: r.ip_address,
      metadata: r.metadata,
    })),
    nextCursor: rows.length === limit ? rows[rows.length - 1].created_at : null,
  };
}

// ─── §D: IP Intelligence ─────────────────────────────────────────

export type IpIntelligence = {
  topSuspiciousIps: Array<{
    ip: string;
    failedLogins24h: number;
    actorCount: number;
    sampleActor: string | null;
    lastSeen: string;
  }>;
  multiIpActors: Array<{
    actor: string;
    distinctIps: number;
    sampleIp: string;
    eventCount24h: number;
  }>;
  adminAccessLocations: Array<{
    ip: string;
    actor: string | null;
    actionCount: number;
    lastSeen: string;
  }>;
  generatedAt: string;
  computedInMs: number;
};

export async function computeIpIntelligence(): Promise<IpIntelligence> {
  return memoize(
    "admin:security:ip:v1",
    async () => {
      const t0 = Date.now();

      const susp = (await db.execute(
        sql`SELECT ip_address::text AS ip,
                   COUNT(*) FILTER (WHERE action LIKE 'security.authentication.failed%')::int AS failed_logins,
                   COUNT(DISTINCT actor_label)::int AS actor_count,
                   MAX(actor_label) AS sample_actor,
                   MAX(created_at) AS last_seen
              FROM audit_logs
             WHERE ip_address IS NOT NULL
               AND created_at > NOW() - INTERVAL '24 hours'
             GROUP BY ip_address
            HAVING COUNT(*) FILTER (WHERE action LIKE 'security.authentication.failed%') >= 5
             ORDER BY failed_logins DESC
             LIMIT 20`,
      )) as unknown as Array<{
        ip: string;
        failed_logins: number;
        actor_count: number;
        sample_actor: string | null;
        last_seen: string;
      }>;

      const multi = (await db.execute(
        sql`SELECT actor_label AS actor,
                   COUNT(DISTINCT ip_address)::int AS distinct_ips,
                   MIN(ip_address::text) AS sample_ip,
                   COUNT(*)::int AS event_count
              FROM audit_logs
             WHERE ip_address IS NOT NULL
               AND actor_label IS NOT NULL
               AND created_at > NOW() - INTERVAL '24 hours'
             GROUP BY actor_label
            HAVING COUNT(DISTINCT ip_address) >= 3
             ORDER BY distinct_ips DESC, event_count DESC
             LIMIT 20`,
      )) as unknown as Array<{
        actor: string;
        distinct_ips: number;
        sample_ip: string;
        event_count: number;
      }>;

      const admins = (await db.execute(
        sql`SELECT ip_address::text AS ip,
                   actor_label AS actor,
                   COUNT(*)::int AS action_count,
                   MAX(created_at) AS last_seen
              FROM audit_logs
             WHERE ip_address IS NOT NULL
               AND (action LIKE 'admin.%' OR action LIKE 'security.permission%' OR action ILIKE '%impersonat%')
               AND created_at > NOW() - INTERVAL '7 days'
             GROUP BY ip_address, actor_label
             ORDER BY action_count DESC
             LIMIT 20`,
      )) as unknown as Array<{
        ip: string;
        actor: string | null;
        action_count: number;
        last_seen: string;
      }>;

      return {
        topSuspiciousIps: susp.map((r) => ({
          ip: r.ip,
          failedLogins24h: Number(r.failed_logins),
          actorCount: Number(r.actor_count),
          sampleActor: r.sample_actor,
          lastSeen: r.last_seen,
        })),
        multiIpActors: multi.map((r) => ({
          actor: r.actor,
          distinctIps: Number(r.distinct_ips),
          sampleIp: r.sample_ip,
          eventCount24h: Number(r.event_count),
        })),
        adminAccessLocations: admins.map((r) => ({
          ip: r.ip,
          actor: r.actor,
          actionCount: Number(r.action_count),
          lastSeen: r.last_seen,
        })),
        generatedAt: new Date().toISOString(),
        computedInMs: Date.now() - t0,
      };
    },
    60_000,
  );
}

// ─── §E: Permission & admin tracking ─────────────────────────────

export type PermissionEvent = {
  id: string;
  ts: string;
  category: "role_change" | "permission_grant" | "impersonation" | "bulk_admin" | "financial" | "manual_override";
  action: string;
  actor: string | null;
  tenantId: string | null;
  detail: string;
};

export async function fetchPermissionEvents(args: { limit?: number; cursor?: string | null }): Promise<{
  events: PermissionEvent[];
  nextCursor: string | null;
}> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const cursor = args.cursor ?? null;
  const rows = (await db.execute(
    sql`SELECT id::text AS id, action, actor_label, tenant_id::text AS tenant_id, metadata, created_at
          FROM audit_logs
         WHERE (${cursor}::text IS NULL OR created_at < ${cursor}::timestamptz)
           AND (
                  action LIKE 'security.permission%'
               OR action LIKE 'role%'
               OR action ILIKE '%impersonat%'
               OR action LIKE 'admin.bulk.%'
               OR action LIKE 'admin.finance.%'
               OR action LIKE 'admin.override%'
               OR action LIKE 'tenant.suspended%'
               OR action LIKE 'tenant.reactivated%'
             )
         ORDER BY created_at DESC
         LIMIT ${limit}`,
  )) as unknown as Array<{
    id: string;
    action: string;
    actor_label: string | null;
    tenant_id: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }>;

  const events: PermissionEvent[] = rows.map((r) => {
    let cat: PermissionEvent["category"];
    if (r.action.startsWith("security.permission")) cat = "permission_grant";
    else if (r.action.startsWith("role")) cat = "role_change";
    else if (r.action.toLowerCase().includes("impersonat")) cat = "impersonation";
    else if (r.action.startsWith("admin.bulk.")) cat = "bulk_admin";
    else if (r.action.startsWith("admin.finance.")) cat = "financial";
    else cat = "manual_override";

    const md = r.metadata ?? {};
    const reason = typeof md.reason === "string" ? ` · "${md.reason.slice(0, 60)}"` : "";
    return {
      id: r.id,
      ts: r.created_at,
      category: cat,
      action: r.action,
      actor: r.actor_label,
      tenantId: r.tenant_id,
      detail: `${r.action.replace(/^(admin\.|security\.)/, "")}${reason}`,
    };
  });

  return { events, nextCursor: rows.length === limit ? rows[rows.length - 1].created_at : null };
}
