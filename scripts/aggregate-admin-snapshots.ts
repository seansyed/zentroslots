#!/usr/bin/env tsx
/**
 * aggregate-admin-snapshots.ts — SA-10 cron worker.
 *
 * Builds rows in the four super-admin snapshot tables:
 *   - analytics_snapshots_daily
 *   - analytics_snapshots_hourly
 *   - tenant_health_snapshots
 *   - financial_snapshots
 *
 * Modes (via env or argv):
 *   AGG_MODE=daily    aggregates yesterday's daily row (default)
 *   AGG_MODE=hourly   aggregates last completed hour
 *   AGG_MODE=tenant   refreshes tenant_health for today
 *   AGG_MODE=finance  refreshes financial_snapshots for today
 *   AGG_MODE=all      runs the four passes in sequence (use sparingly)
 *
 * Backfill:
 *   BACKFILL_DAYS=N   for daily/tenant/finance modes; also aggregates
 *                     the prior N days (e.g. for first deploy).
 *   BACKFILL_HOURS=N  for hourly mode.
 *
 * Cron suggestions (Linux):
 *   *  /10 *  * * *   AGG_MODE=hourly  node scripts/aggregate-admin-snapshots.ts
 *   15 1   *  * * *   AGG_MODE=daily   node scripts/aggregate-admin-snapshots.ts
 *   30 *   *  * * *   AGG_MODE=tenant  node scripts/aggregate-admin-snapshots.ts
 *   *  /15 *  * * *   AGG_MODE=finance node scripts/aggregate-admin-snapshots.ts
 *
 * Each pass runs in its own try/catch so a partial failure cannot
 * block the others. Retention is applied at the end of every run.
 */
import "dotenv/config";

import {
  applyRetention,
  upsertDailySnapshot,
  upsertFinancialSnapshots,
  upsertHourlySnapshot,
  upsertTenantHealthSnapshots,
} from "../lib/admin-analytics/snapshots";

const ONE_DAY_MS = 24 * 60 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoHour(d: Date): string {
  // Truncate to hour, return as ISO with :00:00.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()));
  return t.toISOString();
}

async function runDaily(backfill: number) {
  const todayStart = new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    ),
  );
  const target = new Date(todayStart.getTime() - ONE_DAY_MS);
  const days: string[] = [isoDate(target)];
  for (let i = 1; i <= backfill; i++) {
    days.push(isoDate(new Date(target.getTime() - i * ONE_DAY_MS)));
  }
  for (const d of days) {
    try {
      await upsertDailySnapshot(d);
      console.log(JSON.stringify({ evt: "snapshot.daily.ok", date: d }));
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "snapshot.daily.fail",
          date: d,
          reason: err instanceof Error ? err.message : "unknown",
        }),
      );
    }
  }
}

async function runHourly(backfillHours: number) {
  // Aggregate the last fully completed hour: e.g. if it's 14:23 UTC,
  // we aggregate 13:00–14:00 by writing to row snapshot_hour=13:00.
  const now = new Date();
  const completedHour = new Date(now.getTime() - ONE_HOUR_MS);
  const hours: string[] = [isoHour(completedHour)];
  for (let i = 1; i <= backfillHours; i++) {
    hours.push(isoHour(new Date(completedHour.getTime() - i * ONE_HOUR_MS)));
  }
  for (const h of hours) {
    try {
      await upsertHourlySnapshot(h);
      console.log(JSON.stringify({ evt: "snapshot.hourly.ok", hour: h }));
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "snapshot.hourly.fail",
          hour: h,
          reason: err instanceof Error ? err.message : "unknown",
        }),
      );
    }
  }
}

async function runTenant() {
  const today = isoDate(new Date());
  try {
    const out = await upsertTenantHealthSnapshots(today);
    console.log(JSON.stringify({ evt: "snapshot.tenant.ok", date: today, rows: out.rows }));
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "snapshot.tenant.fail",
        date: today,
        reason: err instanceof Error ? err.message : "unknown",
      }),
    );
  }
}

async function runFinance(backfill: number) {
  const todayStart = new Date(
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    ),
  );
  const days: string[] = [isoDate(todayStart)];
  for (let i = 1; i <= backfill; i++) {
    days.push(isoDate(new Date(todayStart.getTime() - i * ONE_DAY_MS)));
  }
  for (const d of days) {
    try {
      const out = await upsertFinancialSnapshots(d);
      console.log(JSON.stringify({ evt: "snapshot.finance.ok", date: d, rows: out.rows }));
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: "snapshot.finance.fail",
          date: d,
          reason: err instanceof Error ? err.message : "unknown",
        }),
      );
    }
  }
}

(async () => {
  const mode = (process.env.AGG_MODE ?? process.argv[2] ?? "daily").toLowerCase();
  const backfillDays = Number(process.env.BACKFILL_DAYS ?? 0);
  const backfillHours = Number(process.env.BACKFILL_HOURS ?? 0);

  const started = Date.now();
  console.log(JSON.stringify({ evt: "snapshot.run.start", mode, backfillDays, backfillHours }));

  switch (mode) {
    case "daily":
      await runDaily(backfillDays);
      break;
    case "hourly":
      await runHourly(backfillHours);
      break;
    case "tenant":
    case "tenants":
      await runTenant();
      break;
    case "finance":
    case "financial":
      await runFinance(backfillDays);
      break;
    case "all":
      await runHourly(backfillHours);
      await runDaily(backfillDays);
      await runTenant();
      await runFinance(backfillDays);
      break;
    default:
      console.error(JSON.stringify({ evt: "snapshot.run.bad_mode", mode }));
      process.exit(2);
  }

  // Retention — runs every pass, idempotent if the table is already trimmed.
  try {
    const retention = await applyRetention();
    console.log(JSON.stringify({ evt: "snapshot.retention.ok", ...retention }));
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "snapshot.retention.fail",
        reason: err instanceof Error ? err.message : "unknown",
      }),
    );
  }

  console.log(
    JSON.stringify({ evt: "snapshot.run.done", mode, ms: Date.now() - started }),
  );
  process.exit(0);
})().catch((err) => {
  console.error(
    JSON.stringify({
      evt: "snapshot.run.fatal",
      reason: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
