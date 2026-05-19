import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { log } from "@/lib/logger";

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
