#!/usr/bin/env tsx
/**
 * aggregate-daily-analytics.ts
 *
 * Builds analytics_daily_snapshots rows for all tenants.
 *
 *   By default: aggregates YESTERDAY (UTC) — the most recent fully-
 *   closed day. Re-runnable safely (UPSERT).
 *
 *   With BACKFILL_DAYS=N env: also aggregates the prior N days. Useful
 *   for filling in history after deploying analytics for the first
 *   time.
 *
 *   Linux cron:  10 1 * * *  (cd /app && npm run analytics:aggregate)
 *
 * Never crashes the batch — each (tenant, day) is its own try/catch.
 * Rule #13 — analytics failures NEVER affect booking flows.
 */
import "dotenv/config";

import { db } from "../db/client";
import { tenants } from "../db/schema";
import { aggregateDailyAnalytics } from "../lib/analytics/aggregation";

const ONE_DAY_MS = 24 * 60 * 60_000;

(async () => {
  try {
    // Yesterday at UTC midnight is the canonical target.
    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const yesterdayStart = new Date(todayStart.getTime() - ONE_DAY_MS);

    const backfillDays = Number(process.env.BACKFILL_DAYS ?? 0);
    const days: Date[] = [yesterdayStart];
    for (let i = 1; i <= backfillDays; i++) {
      days.push(new Date(yesterdayStart.getTime() - i * ONE_DAY_MS));
    }

    const tenantRows = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
    let ok = 0;
    let failed = 0;
    for (const t of tenantRows) {
      for (const d of days) {
        try {
          const r = await aggregateDailyAnalytics({ tenantId: t.id, dayStart: d });
          if (r.ok) ok++;
          else failed++;
        } catch (e) {
          console.error(`[analytics] (${t.name}, ${d.toISOString().slice(0, 10)}) crashed:`, e);
          failed++;
        }
      }
    }
    console.log(
      `[analytics] tenants=${tenantRows.length} days=${days.length} ok=${ok} failed=${failed}`
    );
    process.exit(0);
  } catch (e) {
    console.error("[analytics] worker crashed:", e);
    process.exit(1);
  }
})();
