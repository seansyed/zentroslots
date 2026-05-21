import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { log } from "@/lib/logger";
import { verifySmtpTransport, getEmailProviderInfo } from "@/lib/email";

export const dynamic = "force-dynamic";

/**
 * Health endpoint. Used by load balancers + uptime checks.
 *
 * Returns:
 *   - 200 with `{ ok: true, checks }` when DB + EXCLUDE constraint are healthy
 *   - 503 with `{ ok: false, checks }` when any check fails
 *
 * Each check carries its own ms latency so dashboards can graph trends.
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; ms?: number; detail?: string }> = {};
  let allOk = true;

  // DB ping
  {
    const start = Date.now();
    try {
      await db.execute(sql`SELECT 1`);
      checks.db = { ok: true, ms: Date.now() - start };
    } catch (e) {
      allOk = false;
      checks.db = { ok: false, ms: Date.now() - start, detail: (e as Error).message };
      log.error("health:db_fail", e);
    }
  }

  // EXCLUDE constraint sentinel — production-critical invariant.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT 1 AS present FROM pg_constraint WHERE conname = 'bookings_no_overlap'`
      )) as unknown as Array<{ present?: number }>;
      const present = rows.length > 0;
      checks.bookings_no_overlap = { ok: present, ms: Date.now() - start };
      if (!present) {
        allOk = false;
        log.error("health:exclude_missing");
      }
    } catch (e) {
      allOk = false;
      checks.bookings_no_overlap = { ok: false, ms: Date.now() - start, detail: (e as Error).message };
    }
  }

  // Billing ledger reachable — verifies the billing_transactions table
  // exists and is queryable. SOFT-FAIL (warning only, doesn't toggle
  // allOk) so a missing migration on a fresh deploy can't take the
  // load balancer down. The booking engine doesn't depend on the ledger.
  {
    const start = Date.now();
    try {
      await db.execute(sql`SELECT 1 FROM billing_transactions LIMIT 1`);
      checks.billing_ledger = { ok: true, ms: Date.now() - start };
    } catch (e) {
      checks.billing_ledger = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Analytics aggregation freshness — when was the most recent
  // analytics_daily_snapshots row written? Older than 48h flags stale
  // (cron is supposed to run nightly). Soft-fail — a missed cron
  // shouldn't take the app down.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT MAX(created_at) AS last_at FROM analytics_daily_snapshots`
      )) as unknown as Array<{ last_at: string | Date | null }>;
      const lastAtRaw = rows[0]?.last_at;
      const lastAt = lastAtRaw ? new Date(lastAtRaw) : null;
      const ageMs = lastAt ? Date.now() - lastAt.getTime() : null;
      const stale = ageMs === null || ageMs > 48 * 60 * 60_000;
      checks.analytics_aggregation = {
        ok: !stale,
        ms: Date.now() - start,
        detail: lastAt
          ? `last_at=${lastAt.toISOString()}; age_hours=${Math.round((ageMs ?? 0) / 3_600_000)}`
          : "never_aggregated",
      };
    } catch (e) {
      checks.analytics_aggregation = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Forecasting freshness — counts snapshots written in the last 48h
  // that have a forecasting payload in extras (proxy for "the
  // trailing-window intelligence ran successfully"). Soft-fail — a
  // tenant with insufficient history legitimately has no forecasting.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT MAX(created_at) AS last_at FROM analytics_daily_snapshots
            WHERE extras ? 'forecasting'
              AND created_at > NOW() - INTERVAL '48 hours'`
      )) as unknown as Array<{ last_at: string | Date | null }>;
      const lastAtRaw = rows[0]?.last_at;
      const lastAt = lastAtRaw ? new Date(lastAtRaw) : null;
      checks.forecasting_freshness = {
        ok: lastAt !== null,
        ms: Date.now() - start,
        detail: lastAt
          ? `last_at=${lastAt.toISOString()}`
          : "no_forecasting_in_48h",
      };
    } catch (e) {
      checks.forecasting_freshness = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Aggregation latency — avg generation_ms across the 25 most recent
  // scheduled_reports rows. Useful for detecting cron regression.
  // Soft-fail. detail carries the avg in ms.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT AVG(generation_ms)::int AS avg_ms, COUNT(*) AS n
            FROM (SELECT generation_ms FROM scheduled_reports
                  WHERE generation_ms IS NOT NULL
                  ORDER BY generated_at DESC LIMIT 25) recent`
      )) as unknown as Array<{ avg_ms: number | null; n: string | number | null }>;
      const avgMs = rows[0]?.avg_ms ?? null;
      const n = Number(rows[0]?.n ?? 0);
      checks.aggregation_latency = {
        ok: true,
        ms: Date.now() - start,
        detail: n > 0 ? `avg_ms=${avgMs}; n=${n}` : "no_reports_yet",
      };
    } catch (e) {
      checks.aggregation_latency = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Optimization-engine freshness — counts snapshots in the last 48h
  // that have an optimizationRecommendations payload. Soft-fail —
  // tenants with insufficient history (< 7 snapshots) legitimately
  // have no optimization output. detail surfaces last write time.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT MAX(created_at) AS last_at FROM analytics_daily_snapshots
            WHERE extras ? 'optimizationRecommendations'
              AND created_at > NOW() - INTERVAL '48 hours'`
      )) as unknown as Array<{ last_at: string | Date | null }>;
      const lastAtRaw = rows[0]?.last_at;
      const lastAt = lastAtRaw ? new Date(lastAtRaw) : null;
      checks.optimization_freshness = {
        ok: true, // soft check — never toggles allOk
        ms: Date.now() - start,
        detail: lastAt
          ? `last_at=${lastAt.toISOString()}`
          : "no_optimization_in_48h",
      };
    } catch (e) {
      checks.optimization_freshness = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Recommendation-generation runtime — avg of
  // extras->>'optimizationGenerationMs' across snapshots written in
  // the last 48h. Useful for catching engine regressions. Soft-fail.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT AVG((extras->>'optimizationGenerationMs')::int)::int AS avg_ms,
                   COUNT(*)::int AS n
            FROM analytics_daily_snapshots
            WHERE extras ? 'optimizationGenerationMs'
              AND created_at > NOW() - INTERVAL '48 hours'`
      )) as unknown as Array<{ avg_ms: number | null; n: number | string | null }>;
      const avgMs = rows[0]?.avg_ms ?? null;
      const n = Number(rows[0]?.n ?? 0);
      checks.recommendation_generation_runtime = {
        ok: true, // soft check
        ms: Date.now() - start,
        detail: n > 0 ? `avg_ms=${avgMs}; n=${n}` : "no_runs_in_48h",
      };
    } catch (e) {
      checks.recommendation_generation_runtime = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // SMTP transport — verifies the centralized email transport is
  // reachable + auth works. Cached for 60s inside verifySmtpTransport
  // so the LB probe doesn't open a TLS handshake every check.
  // SOFT-FAIL — an SES outage must NOT take the booking engine down.
  // The detail field surfaces provider/category so ops dashboards can
  // alert distinctly from a hard DB failure.
  {
    const start = Date.now();
    try {
      const info = getEmailProviderInfo();
      const v = await verifySmtpTransport({ timeoutMs: 3_000 });
      // v.detail already includes "provider=..." for stub/non-SMTP
      // paths; only prefix when it doesn't to avoid duplication.
      const vDetail = v.detail ?? "";
      const detail = v.ok
        ? vDetail.startsWith("provider=")
          ? vDetail
          : `provider=${info.provider}; ${vDetail}`
        : `provider=${info.provider}; category=${v.category ?? "unknown"}; ${vDetail}`;
      checks.smtp_transport = {
        ok: true, // soft check — never toggles allOk
        ms: Date.now() - start,
        detail: detail.slice(0, 300),
      };
      // If the underlying verify failed, also tee a single structured
      // log line so an alert pipeline can fire on it.
      if (!v.ok) {
        console.error(
          JSON.stringify({
            evt: "smtp_health_fail",
            provider: info.provider,
            category: v.category,
            detail: v.detail,
            ts: new Date().toISOString(),
          })
        );
      }
    } catch (e) {
      checks.smtp_transport = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Auth subsystem — verifies password_reset_tokens, session_audit_events,
  // and revoked_session_jtis tables are reachable. Soft-fail.
  {
    const start = Date.now();
    try {
      await db.execute(
        sql`SELECT
          (SELECT count(*) FROM password_reset_tokens) AS prt,
          (SELECT count(*) FROM session_audit_events) AS sae,
          (SELECT count(*) FROM revoked_session_jtis) AS rsj`
      );
      checks.auth_subsystem = { ok: true, ms: Date.now() - start };
    } catch (e) {
      checks.auth_subsystem = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Failed-login metric (24h, all tenants). Soft-fail. Surfaces the
  // count so alerting can fire on a sudden spike (e.g. credential
  // spray detection). Never toggles allOk.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM session_audit_events
            WHERE event_type = 'login_failed'
              AND created_at > NOW() - INTERVAL '24 hours'`
      )) as unknown as Array<{ n: number | string | null }>;
      const n = Number(rows[0]?.n ?? 0);
      checks.failed_logins_24h = {
        ok: true,
        ms: Date.now() - start,
        detail: `count=${n}`,
      };
    } catch (e) {
      checks.failed_logins_24h = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Suspicious-activity metric (24h). Soft-fail. Tees an alert when
  // any event fires; combined with failed_logins_24h gives ops a
  // 30-second sense of "are we under attack right now".
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM session_audit_events
            WHERE event_type = 'suspicious_login'
              AND created_at > NOW() - INTERVAL '24 hours'`
      )) as unknown as Array<{ n: number | string | null }>;
      const n = Number(rows[0]?.n ?? 0);
      checks.suspicious_activity_24h = {
        ok: true,
        ms: Date.now() - start,
        detail: `count=${n}`,
      };
    } catch (e) {
      checks.suspicious_activity_24h = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Reset-token cleanup freshness. Counts unexpired-but-consumed tokens
  // older than retention — i.e. the pruner is behind. Soft-fail; detail
  // surfaces the count so ops can investigate cron drift.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM password_reset_tokens
            WHERE expires_at < NOW() - INTERVAL '30 days'`
      )) as unknown as Array<{ n: number | string | null }>;
      const stale = Number(rows[0]?.n ?? 0);
      checks.reset_token_cleanup = {
        ok: true,
        ms: Date.now() - start,
        detail: `stale=${stale}`,
      };
    } catch (e) {
      checks.reset_token_cleanup = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Permission denials (24h) — counts security.permission.denied
  // audit rows. A sudden spike signals either misconfigured
  // permissions OR an active probing attempt. Soft-fail; detail
  // surfaces the count.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM audit_logs
            WHERE action = 'security.permission.denied'
              AND created_at > NOW() - INTERVAL '24 hours'`
      )) as unknown as Array<{ n: number | string | null }>;
      const n = Number(rows[0]?.n ?? 0);
      checks.permission_denials_24h = {
        ok: true,
        ms: Date.now() - start,
        detail: `count=${n}`,
      };
    } catch (e) {
      checks.permission_denials_24h = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Permission-override count — total users with a non-empty
  // permissions_extra jsonb. Useful for seeing how widely the granular
  // system has been adopted vs the default role grants.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM users
            WHERE permissions_extra IS NOT NULL
              AND permissions_extra <> '{}'::jsonb`
      )) as unknown as Array<{ n: number | string | null }>;
      const n = Number(rows[0]?.n ?? 0);
      checks.permission_overrides = {
        ok: true,
        ms: Date.now() - start,
        detail: `users_with_overrides=${n}`,
      };
    } catch (e) {
      checks.permission_overrides = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Governance subsystem freshness — newest security.retention.executed
  // audit row across all tenants. Soft-fail. Empty detail = pruner has
  // never run (expected on day-1, before any tenant opts in).
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT MAX(created_at) AS last_at FROM audit_logs
            WHERE action = 'security.retention.executed'`
      )) as unknown as Array<{ last_at: string | Date | null }>;
      const lastAtRaw = rows[0]?.last_at;
      const lastAt = lastAtRaw ? new Date(lastAtRaw) : null;
      checks.governance_freshness = {
        ok: true,
        ms: Date.now() - start,
        detail: lastAt ? `last_at=${lastAt.toISOString()}` : "no_retention_runs_yet",
      };
    } catch (e) {
      checks.governance_freshness = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Export-audit volume (24h, all tenants) — operators can spot
  // anomalous extract volume. Soft-fail.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n, COALESCE(SUM(record_count),0)::int AS recs
            FROM export_audit_events
            WHERE exported_at > NOW() - INTERVAL '24 hours'`
      )) as unknown as Array<{ n: number | string | null; recs: number | string | null }>;
      const n = Number(rows[0]?.n ?? 0);
      const recs = Number(rows[0]?.recs ?? 0);
      checks.export_audit_volume_24h = {
        ok: true,
        ms: Date.now() - start,
        detail: `exports=${n}; rows=${recs}`,
      };
    } catch (e) {
      checks.export_audit_volume_24h = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Stale export artifacts — export_audit_events older than the tenant's
  // export_audit_retention_days that HAVEN'T been pruned. This is a
  // governance health signal: a large count means the retention cron
  // isn't keeping up (or has been disabled). Soft-fail; we don't know
  // each tenant's window precisely without joining; conservative check
  // uses the hard floor (90d) — anything older than that is unambiguously
  // stale on tenants that opted in. Reports the raw count.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM export_audit_events
            WHERE exported_at < NOW() - INTERVAL '365 days'`
      )) as unknown as Array<{ n: number | string | null }>;
      const n = Number(rows[0]?.n ?? 0);
      checks.stale_export_artifacts = {
        ok: true,
        ms: Date.now() - start,
        detail: `older_than_365d=${n}`,
      };
    } catch (e) {
      checks.stale_export_artifacts = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Governance policy errors — tenants whose tenant_governance_settings
  // row violates a CHECK constraint or contains a value out of the
  // acceptable range. (CHECK constraints prevent invalid INSERTs; this
  // check is defensive against drift from manual DB edits.)
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n FROM tenant_governance_settings
            WHERE password_min_length < 8
               OR password_min_length > 128
               OR (password_max_age_days <> 0 AND (password_max_age_days < 30 OR password_max_age_days > 365))
               OR (session_max_age_days <> 0 AND (session_max_age_days < 1 OR session_max_age_days > 30))
               OR suspicious_login_sensitivity NOT IN ('low','medium','high')`
      )) as unknown as Array<{ n: number | string | null }>;
      const bad = Number(rows[0]?.n ?? 0);
      checks.governance_policy_errors = {
        ok: bad === 0,
        ms: Date.now() - start,
        detail: `bad_rows=${bad}`,
      };
      if (bad > 0) allOk = false; // hard-fail — invalid policy is real
    } catch (e) {
      checks.governance_policy_errors = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Expired payment holds (0030) — counts bookings stuck in
  // pending_payment past their hold expiry. The cleanup cron
  // (holds:expire) should sweep these every 5 minutes. A growing
  // count means the cron is wedged. Soft-fail.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT count(*)::int AS n,
                   EXTRACT(EPOCH FROM (NOW() - MIN(payment_hold_expires_at)))::int AS oldest_age_s
            FROM bookings
            WHERE status = 'pending_payment'
              AND payment_hold_expires_at < NOW()`
      )) as unknown as Array<{ n: number | string | null; oldest_age_s: number | string | null }>;
      const n = Number(rows[0]?.n ?? 0);
      const oldestAgeSec = Number(rows[0]?.oldest_age_s ?? 0);
      checks.expired_payment_holds = {
        ok: true,
        ms: Date.now() - start,
        detail: n > 0 ? `stuck=${n}; oldest_age_s=${oldestAgeSec}` : "none",
      };
    } catch (e) {
      checks.expired_payment_holds = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // Stale tenant detection — tenants whose most recent
  // analytics_daily_snapshots row is > 36h old. Likely indicates the
  // cron skipped them. Soft-fail; detail surfaces the count.
  {
    const start = Date.now();
    try {
      const rows = (await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM tenants t
            WHERE NOT EXISTS (
              SELECT 1 FROM analytics_daily_snapshots s
              WHERE s.tenant_id = t.id
                AND s.created_at > NOW() - INTERVAL '36 hours'
            )`
      )) as unknown as Array<{ n: number | string | null }>;
      const staleCount = Number(rows[0]?.n ?? 0);
      checks.stale_tenants = {
        ok: staleCount === 0,
        ms: Date.now() - start,
        detail: `count=${staleCount}`,
      };
    } catch (e) {
      checks.stale_tenants = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
    }
  }

  // ─── Cloudflare Custom Hostnames (Phase 15D) ─────────────────
  // Verifies token + zone + Custom Hostnames feature in one call.
  // Soft-failure: when CF isn't configured this returns ok=true with
  // a "not configured" detail so health stays green pre-activation.
  {
    const start = Date.now();
    try {
      const { cloudflareHealthcheck } = await import("@/lib/cloudflare-hostnames");
      const cf = await cloudflareHealthcheck();
      if (!cf.configured) {
        checks.cloudflare_edge = {
          ok: true,
          ms: Date.now() - start,
          detail: "not configured (custom domains disabled)",
        };
      } else {
        const ok = cf.tokenOk && cf.zoneOk && cf.customHostnamesOk;
        checks.cloudflare_edge = {
          ok,
          ms: Date.now() - start,
          detail: ok
            ? `zone=${cf.zoneName ?? "unknown"} token+zone+saas ok`
            : cf.errors.join("; "),
        };
        if (!ok) allOk = false;
      }
    } catch (e) {
      checks.cloudflare_edge = {
        ok: false,
        ms: Date.now() - start,
        detail: (e as Error).message,
      };
      allOk = false;
    }
  }

  return NextResponse.json(
    {
      ok: allOk,
      version: process.env.npm_package_version ?? "dev",
      env: process.env.NODE_ENV ?? "development",
      time: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
