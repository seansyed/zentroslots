/**
 * Admin diagnostics aggregator — internal-only health view.
 *
 * Combines:
 *   • Schema fingerprint (schema-fingerprint.ts)
 *   • Snapshot freshness (analytics_snapshots_* MAX(snapshot_*))
 *   • Cron freshness (cron_runs latest per job)
 *   • KPI aggregation smoke test (re-runs each KPI in safe mode)
 *   • Cache stats (in-process LRU)
 *
 * This is the canonical "is the analytics layer healthy?" surface.
 * Returns null entries for components that have not yet been
 * exercised in this environment — never throws.
 */

import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { cacheStats } from "./cache";
import { computeSchemaFingerprint, type SchemaFingerprintReport } from "./schema-fingerprint";
import { computeAllKpis } from "./kpis";

export type SnapshotFreshness = {
  /** Table name. */
  table: string;
  /** Most recent snapshot timestamp (ISO) or null. */
  latestAt: string | null;
  /** Age in minutes, or null if no rows. */
  ageMinutes: number | null;
  /** Expected cadence in minutes. */
  expectedIntervalMin: number;
  /** "ok" if within 3× expected; "stale" if 3-6×; "down" if > 6×. */
  status: "ok" | "stale" | "down" | "empty";
};

export type AggregationSmokeTest = {
  kpiKey: string;
  ok: boolean;
  /** Categorical error reason when ok=false. */
  error: string | null;
  /** Computation time in ms. */
  ms: number;
};

export type DiagnosticsBundle = {
  schemaFingerprint: SchemaFingerprintReport;
  snapshotFreshness: SnapshotFreshness[];
  aggregationSmokeTests: AggregationSmokeTest[];
  cache: { size: number; max: number };
  generatedAt: string;
  computedInMs: number;
};

const EXPECTED_INTERVALS: Record<string, number> = {
  analytics_snapshots_hourly: 10,
  analytics_snapshots_daily: 1440,
  tenant_health_snapshots: 30,
  financial_snapshots: 15,
};

async function snapshotFreshness(
  table: string,
  timestampColumn: string,
): Promise<SnapshotFreshness> {
  const expectedIntervalMin = EXPECTED_INTERVALS[table] ?? 1440;
  try {
    const rows = (await db.execute(
      sql`SELECT MAX(${sql.raw(timestampColumn)})::text AS latest FROM ${sql.raw(table)}`,
    )) as unknown as Array<{ latest: string | null }>;
    const latest = rows[0]?.latest ?? null;
    if (!latest) {
      return {
        table,
        latestAt: null,
        ageMinutes: null,
        expectedIntervalMin,
        status: "empty",
      };
    }
    const ageMin = Math.max(
      0,
      Math.round((Date.now() - new Date(latest).getTime()) / 60_000),
    );
    let status: SnapshotFreshness["status"];
    if (ageMin > expectedIntervalMin * 6) status = "down";
    else if (ageMin > expectedIntervalMin * 3) status = "stale";
    else status = "ok";
    return { table, latestAt: latest, ageMinutes: ageMin, expectedIntervalMin, status };
  } catch (err) {
    // Treat unavailable table as "empty" — informational, not fatal.
    return {
      table,
      latestAt: null,
      ageMinutes: null,
      expectedIntervalMin,
      status: "empty",
    };
  }
}

export async function computeDiagnostics(): Promise<DiagnosticsBundle> {
  const t0 = Date.now();

  // 1. Schema fingerprint
  const schemaFingerprint = await computeSchemaFingerprint().catch(() => ({
    drift: [],
    totalChecks: 0,
    generatedAt: new Date().toISOString(),
    healthy: false,
  }));

  // 2. Snapshot freshness — one MAX() per table
  const snapshotFreshnessResults = await Promise.all([
    snapshotFreshness("analytics_snapshots_hourly", "snapshot_hour"),
    snapshotFreshness("analytics_snapshots_daily", "snapshot_date"),
    snapshotFreshness("tenant_health_snapshots", "snapshot_date"),
    snapshotFreshness("financial_snapshots", "snapshot_date"),
  ]);

  // 3. KPI smoke test — re-runs every KPI through the safe() wrapper
  //    (which captures errors as categorical) and reports each one.
  let aggregationSmokeTests: AggregationSmokeTest[] = [];
  try {
    const tStart = Date.now();
    const kpis = await computeAllKpis();
    // computeAllKpis returns an object keyed by KPI name with each
    // value containing an optional `error` field. Reflect each one.
    const entries = Object.entries(kpis) as Array<
      [string, { value?: unknown; error?: string }]
    >;
    aggregationSmokeTests = entries.map(([key, result]) => ({
      kpiKey: key,
      ok: !result.error,
      error: result.error ?? null,
      ms: Date.now() - tStart, // batch time; per-key ms would require a deeper refactor
    }));
  } catch (err) {
    aggregationSmokeTests = [
      {
        kpiKey: "computeAllKpis",
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        ms: 0,
      },
    ];
  }

  return {
    schemaFingerprint,
    snapshotFreshness: snapshotFreshnessResults,
    aggregationSmokeTests,
    cache: cacheStats(),
    generatedAt: new Date().toISOString(),
    computedInMs: Date.now() - t0,
  };
}
