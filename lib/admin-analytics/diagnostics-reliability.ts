/**
 * Admin Diagnostics Reliability Intelligence — pure composite scoring.
 *
 * Philosophy (strict):
 *   • NO new SQL queries — derives EVERYTHING from the existing
 *     DiagnosticsBundle (schema fingerprint + snapshot freshness +
 *     KPI smoke tests + cache stats).
 *   • NO LLM. NO fabricated health signals.
 *   • Deterministic functions of (drift count × KPI ok rate × snapshot
 *     status × cache utilization) — explainable line by line.
 *
 * Pure module — types-only import from diagnostics.ts, no DB dep,
 * safe to import from both server and "use client" components.
 *
 * Hero scores (0-100):
 *   • overallReliabilityScore    — weighted composite of all axes
 *   • schemaIntegrity            — 100 if zero drift, falls with drift
 *   • snapshotFreshnessConfidence — % of snapshots in "ok" state
 *   • aggregationReliability     — KPI smoke pass rate × latency factor
 *   • analyticsConfidence        — composite of snapshots + aggregations
 *   • cacheHealth                — utilization sweet spot 5-70%
 *   • operationalConfidence      — same as overallReliabilityScore but
 *                                   tone-mapped for the rail
 */

import type {
  AggregationSmokeTest,
  DiagnosticsBundle,
  SnapshotFreshness,
} from "./diagnostics";
import type { SchemaFingerprintReport } from "./schema-fingerprint";

// ─── Client-safe types ────────────────────────────────────────────

export type ReliabilityPosture = "healthy" | "monitoring" | "degraded" | "recovering" | "failing";

export type DiagnosticsReliabilityKpis = {
  /** Overall reliability classification. */
  posture: ReliabilityPosture;
  /** Weighted composite 0-100 (higher = better). */
  overallReliabilityScore: number;
  /** Schema integrity 0-100. */
  schemaIntegrity: number;
  /** Snapshot freshness % in "ok" state. NULL when no snapshot tables. */
  snapshotFreshnessConfidence: number | null;
  /** KPI smoke pass rate × latency factor. NULL when no tests. */
  aggregationReliability: number | null;
  /** Composite of snapshots + aggregations. NULL when insufficient signal. */
  analyticsConfidence: number | null;
  /** Cache utilization sweet-spot score. */
  cacheHealth: number;
  /** Raw counts for tile detail copy. */
  schemaDriftCount: number;
  schemaTotalChecks: number;
  snapshotOkCount: number;
  snapshotStaleCount: number;
  snapshotDownCount: number;
  snapshotEmptyCount: number;
  snapshotTotal: number;
  kpiOkCount: number;
  kpiFailCount: number;
  kpiTotal: number;
  cacheUtilizationPct: number;
};

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ─── Composite scoring ────────────────────────────────────────────

export function deriveDiagnosticsReliability(
  bundle: DiagnosticsBundle,
): DiagnosticsReliabilityKpis {
  // ─── Schema integrity ─────────────────────────────────────────
  const driftCount = bundle.schemaFingerprint.drift.length;
  const totalChecks = bundle.schemaFingerprint.totalChecks;
  // Each drift entry costs 20 pts (cap at 100 total). Table-missing
  // entries cost more because they're catastrophic (counted via the
  // raw missingColumns absence already in the engine).
  const driftPenalty = bundle.schemaFingerprint.drift.reduce((sum, d) => {
    return sum + (d.tableMissing ? 35 : 20);
  }, 0);
  const schemaIntegrity = clamp(100 - driftPenalty, 0, 100);

  // ─── Snapshot freshness confidence ────────────────────────────
  const snapshots = bundle.snapshotFreshness;
  const snapshotOkCount = snapshots.filter((s) => s.status === "ok").length;
  const snapshotStaleCount = snapshots.filter((s) => s.status === "stale").length;
  const snapshotDownCount = snapshots.filter((s) => s.status === "down").length;
  const snapshotEmptyCount = snapshots.filter((s) => s.status === "empty").length;
  const snapshotTotal = snapshots.length;
  const snapshotFreshnessConfidence =
    snapshotTotal === 0
      ? null
      : Math.round(
          ((snapshotOkCount + 0.5 * snapshotStaleCount) / snapshotTotal) * 100,
        );

  // ─── Aggregation reliability ──────────────────────────────────
  const kpiTotal = bundle.aggregationSmokeTests.length;
  const kpiOkCount = bundle.aggregationSmokeTests.filter((t) => t.ok).length;
  const kpiFailCount = kpiTotal - kpiOkCount;
  // Pass rate × latency factor: < 500ms = 1.0, < 1500ms = 0.9, ≥ 3000ms = 0.7
  const avgMs =
    kpiTotal > 0
      ? bundle.aggregationSmokeTests.reduce((sum, t) => sum + (t.ms || 0), 0) / kpiTotal
      : 0;
  const latencyFactor = avgMs < 500 ? 1.0 : avgMs < 1500 ? 0.95 : avgMs < 3000 ? 0.85 : 0.7;
  const aggregationReliability =
    kpiTotal === 0
      ? null
      : Math.round((kpiOkCount / kpiTotal) * 100 * latencyFactor);

  // ─── Analytics confidence (composite) ─────────────────────────
  let analyticsConfidence: number | null = null;
  if (snapshotFreshnessConfidence !== null && aggregationReliability !== null) {
    analyticsConfidence = Math.round(
      snapshotFreshnessConfidence * 0.4 + aggregationReliability * 0.6,
    );
  } else if (aggregationReliability !== null) {
    analyticsConfidence = aggregationReliability;
  } else if (snapshotFreshnessConfidence !== null) {
    analyticsConfidence = snapshotFreshnessConfidence;
  }

  // ─── Cache health ─────────────────────────────────────────────
  // Sweet spot 5-70% utilization — under = unused / over = thrashing.
  const cacheMax = Math.max(1, bundle.cache.max);
  const cacheUtilizationPct = Math.round((bundle.cache.size / cacheMax) * 100);
  let cacheHealth = 100;
  if (cacheUtilizationPct > 90) cacheHealth = 60;
  else if (cacheUtilizationPct > 80) cacheHealth = 80;
  else if (cacheUtilizationPct < 1) cacheHealth = 75; // not necessarily a problem — could be fresh boot
  else cacheHealth = 100;

  // ─── Overall reliability (weighted composite) ─────────────────
  // Weights: schema 30% / aggregations 30% / snapshots 25% / cache 15%
  const overallReliabilityScore = Math.round(
    schemaIntegrity * 0.3 +
      (aggregationReliability ?? 80) * 0.3 +
      (snapshotFreshnessConfidence ?? 80) * 0.25 +
      cacheHealth * 0.15,
  );

  // ─── Posture classifier ───────────────────────────────────────
  let posture: ReliabilityPosture = "healthy";
  if (driftCount > 0 || snapshotDownCount > 0 || kpiFailCount > 0) {
    if (
      driftCount >= 2 ||
      snapshotDownCount >= 2 ||
      kpiFailCount >= 3 ||
      overallReliabilityScore < 50
    ) {
      posture = "failing";
    } else if (overallReliabilityScore < 70) {
      posture = "degraded";
    } else {
      posture = "recovering";
    }
  } else if (snapshotStaleCount > 0 || cacheUtilizationPct > 80) {
    posture = "monitoring";
  }

  return {
    posture,
    overallReliabilityScore,
    schemaIntegrity,
    snapshotFreshnessConfidence,
    aggregationReliability,
    analyticsConfidence,
    cacheHealth,
    schemaDriftCount: driftCount,
    schemaTotalChecks: totalChecks,
    snapshotOkCount,
    snapshotStaleCount,
    snapshotDownCount,
    snapshotEmptyCount,
    snapshotTotal,
    kpiOkCount,
    kpiFailCount,
    kpiTotal,
    cacheUtilizationPct,
  };
}

// ─── Deterministic reliability insights ──────────────────────────

export type ReliabilityInsight = {
  id: string;
  surface: "hero" | "schema" | "kpis" | "snapshots" | "cache";
  tone: "positive" | "neutral" | "warning" | "critical";
  label: string;
  detail?: string;
};

export function deriveReliabilityInsights(
  bundle: DiagnosticsBundle,
  kpis: DiagnosticsReliabilityKpis,
): ReliabilityInsight[] {
  const out: ReliabilityInsight[] = [];

  // 1. Stale hourly snapshot
  const hourly = bundle.snapshotFreshness.find(
    (s) => s.table === "analytics_snapshots_hourly",
  );
  if (hourly && (hourly.status === "stale" || hourly.status === "down") && hourly.ageMinutes !== null) {
    out.push({
      id: "hourly_stale",
      surface: "snapshots",
      tone: hourly.status === "down" ? "critical" : "warning",
      label: `Hourly analytics snapshots stale for ${Math.round(hourly.ageMinutes / 60)}h`,
      detail: `Expected every ${hourly.expectedIntervalMin}m · current age ${hourly.ageMinutes}m. Check admin:snapshots:hourly cron.`,
    });
  }

  // 2. Financial snapshot degraded
  const financial = bundle.snapshotFreshness.find((s) => s.table === "financial_snapshots");
  if (financial && (financial.status === "stale" || financial.status === "down")) {
    out.push({
      id: "financial_snapshot_degraded",
      surface: "snapshots",
      tone: financial.status === "down" ? "critical" : "warning",
      label: "Financial snapshot generation degraded",
      detail: `Last generated ${financial.ageMinutes ?? 0}m ago — expected every ${financial.expectedIntervalMin}m.`,
    });
  }

  // 3. Aggregation reliability stable
  if (kpis.aggregationReliability !== null && kpis.aggregationReliability >= 95 && kpis.kpiTotal >= 5) {
    out.push({
      id: "aggregation_stable",
      surface: "kpis",
      tone: "positive",
      label: `Aggregation reliability ${kpis.aggregationReliability}% — stable`,
      detail: `${kpis.kpiOkCount}/${kpis.kpiTotal} KPI aggregations passing. All deterministic queries returning within latency budget.`,
    });
  }

  // 4. KPI execution latency warning
  const avgMs =
    bundle.aggregationSmokeTests.length > 0
      ? bundle.aggregationSmokeTests.reduce((sum, t) => sum + (t.ms || 0), 0) /
        bundle.aggregationSmokeTests.length
      : 0;
  if (avgMs >= 3000 && bundle.aggregationSmokeTests.length >= 5) {
    out.push({
      id: "kpi_latency_high",
      surface: "kpis",
      tone: "warning",
      label: `KPI execution latency elevated — ${Math.round(avgMs)}ms avg`,
      detail: "Aggregation queries running slower than 3s budget — investigate query plans.",
    });
  }

  // 5. Schema drift critical
  if (kpis.schemaDriftCount > 0) {
    const tableMissing = bundle.schemaFingerprint.drift.some((d) => d.tableMissing);
    out.push({
      id: "schema_drift",
      surface: "schema",
      tone: tableMissing ? "critical" : "warning",
      label: `Schema drift on ${kpis.schemaDriftCount} table${kpis.schemaDriftCount === 1 ? "" : "s"}`,
      detail: tableMissing
        ? "One or more tables missing entirely — verify migration applied."
        : "Missing columns detected — re-run latest migration or fix offending query.",
    });
  }

  // 6. Schema healthy reassurance
  if (
    kpis.schemaDriftCount === 0 &&
    kpis.schemaTotalChecks > 0 &&
    kpis.posture === "healthy"
  ) {
    out.push({
      id: "schema_healthy",
      surface: "hero",
      tone: "positive",
      label: `Platform reliability score ${kpis.overallReliabilityScore} — healthy`,
      detail: `All ${kpis.schemaTotalChecks} schema pairs verified · ${kpis.kpiOkCount}/${kpis.kpiTotal} KPIs OK · ${kpis.snapshotOkCount}/${kpis.snapshotTotal} snapshots fresh.`,
    });
  }

  // 7. Cache utilization warning
  if (kpis.cacheUtilizationPct > 90) {
    out.push({
      id: "cache_pressure",
      surface: "cache",
      tone: "warning",
      label: `Cache pressure ${kpis.cacheUtilizationPct}% — near LRU capacity`,
      detail: `${bundle.cache.size}/${bundle.cache.max} entries. May cause increased DB load if entries evict mid-request.`,
    });
  }

  // 8. Failing state explainer
  if (kpis.posture === "failing") {
    const reasons: string[] = [];
    if (kpis.schemaDriftCount > 0) reasons.push(`${kpis.schemaDriftCount} schema drift`);
    if (kpis.kpiFailCount > 0) reasons.push(`${kpis.kpiFailCount} KPI failure${kpis.kpiFailCount === 1 ? "" : "s"}`);
    if (kpis.snapshotDownCount > 0) reasons.push(`${kpis.snapshotDownCount} snapshot down`);
    out.push({
      id: "platform_failing",
      surface: "hero",
      tone: "critical",
      label: "Platform reliability failing — multiple integrity signals firing",
      detail: reasons.join(" · "),
    });
  }

  return out;
}
