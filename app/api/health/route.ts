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
