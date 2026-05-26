/**
 * Operator Diagnostics Mission Control — pure composite scoring.
 *
 * Philosophy (strict):
 *   • NO new SQL queries — derives EVERYTHING from the existing
 *     OpsDiagnosticsBundle (cron_runs + audit_logs).
 *   • NO LLM, NO predictions, NO fake operational metrics.
 *   • Deterministic functions of (cron status × queue count × failure
 *     timestamps) — explainable line by line.
 *   • NULL when uncomputable (UI renders "—").
 *
 * Pure module — types-only import from opsDiagnostics, no DB dep,
 * safe to import from both server and "use client" components.
 *
 * Hero scores (0-100):
 *   • cronHealthScore       — % of known jobs in OK state
 *   • queuePressure         — sum of queue counts × kind weight
 *   • failureVelocity       — failures in last hour vs prior 23h
 *   • infraConfidence       — composite (cronHealth − queue − failures)
 *   • automationReliability — automations job state + queue depth
 *   • incidentSeverity      — composite of down crons + critical queues
 *   • liveThroughput        — cron runs completed in last 60min (proxy
 *                              via heartbeats with age < 60min × interval)
 *
 * Stream-health classifier maps composite signals to:
 *   calm / active / degraded / stalled / critical
 */

import type {
  CronHeartbeat,
  CronStatus,
  OpsDiagnosticsBundle,
  RecentFailure,
  StuckQueueRow,
} from "./opsDiagnostics";

// ─── Client-safe types ────────────────────────────────────────────

export type OpsPlatformStatus = "calm" | "active" | "degraded" | "stalled" | "critical";

export type OpsMissionKpis = {
  /** Overall platform operational status. */
  platformStatus: OpsPlatformStatus;
  /** Cron health % of known jobs in OK state. NULL when no jobs. */
  cronHealthScore: number | null;
  /** Queue pressure 0-100 (higher = more pressure). */
  queuePressure: number;
  /** Failures last hour count. */
  failuresLastHour: number;
  /** Failures prior 23 hours count. */
  failuresPrior23h: number;
  /** Velocity ratio (last hour / hourly-avg of prior 23h). NULL at low volume. */
  failureVelocityRatio: number | null;
  /** Composite infra confidence 0-100 (higher = better). */
  infraConfidence: number;
  /** Automation reliability 0-100 (higher = better). */
  automationReliability: number;
  /** Incident severity 0-100 (higher = worse). */
  incidentSeverity: number;
  /** Live throughput estimate: jobs run in last 60min. */
  liveThroughput: number;
  /** Count of cron jobs by status. */
  cronStatusCounts: Record<CronStatus, number>;
  /** Count of stuck queues. */
  stuckQueuesCount: number;
  /** Total recent failures (24h). */
  recentFailures24h: number;
  /** Critical-class failure count last hour (worker_crash / fatal). */
  criticalFailuresLastHour: number;
};

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

const QUEUE_WEIGHT: Record<string, number> = {
  pending_payment_backlog: 25,
  pending_automations_stuck: 20,
  webhook_signature_failures: 15,
  comms_failures: 10,
};

// ─── Composite scoring ────────────────────────────────────────────

export function deriveOpsMission(bundle: OpsDiagnosticsBundle): OpsMissionKpis {
  const { cronHeartbeats, recentFailures, stuckQueues } = bundle;

  // ─── Cron status counts ─────────────────────────────────────────
  const cronStatusCounts: Record<CronStatus, number> = {
    ok: 0,
    stale: 0,
    down: 0,
    running: 0,
    unknown: 0,
  };
  for (const h of cronHeartbeats) cronStatusCounts[h.status]++;

  const cronTotal = cronHeartbeats.length;
  const cronHealthScore =
    cronTotal === 0
      ? null
      : Math.round(((cronStatusCounts.ok + cronStatusCounts.running) / cronTotal) * 100);

  // ─── Queue pressure ─────────────────────────────────────────────
  let queuePressure = 0;
  for (const q of stuckQueues) {
    const weight = QUEUE_WEIGHT[q.kind] ?? 10;
    // Each occurrence adds weight × log-ish scaling so 100 doesn't
    // dominate over 5. Cap each line at 35.
    const contribution = Math.min(35, weight * (1 + Math.log10(Math.max(1, q.count))));
    queuePressure += contribution;
  }
  queuePressure = clamp(Math.round(queuePressure), 0, 100);

  // ─── Failure velocity ───────────────────────────────────────────
  const oneHourAgo = Date.now() - 60 * 60_000;
  const failuresLastHour = recentFailures.filter(
    (f) => new Date(f.ts).getTime() >= oneHourAgo,
  ).length;
  const failuresPrior23h = recentFailures.length - failuresLastHour;
  const hourlyAvgPrior = failuresPrior23h / 23;
  const failureVelocityRatio =
    recentFailures.length >= 5 && hourlyAvgPrior > 0
      ? Math.round((failuresLastHour / hourlyAvgPrior) * 10) / 10
      : null;

  // Critical class — worker_crash / fatal / cron crash patterns
  const criticalFailuresLastHour = recentFailures.filter((f) => {
    const ts = new Date(f.ts).getTime();
    if (ts < oneHourAgo) return false;
    const label = f.label.toLowerCase();
    return label.includes("crash") || label.includes("fatal");
  }).length;

  // ─── Infra confidence (higher = better) ────────────────────────
  // Starts at 100. Subtracts: down crons × 15, stale crons × 5,
  // queue pressure × 0.5, failure velocity penalty.
  let infraConfidence = 100;
  infraConfidence -= cronStatusCounts.down * 15;
  infraConfidence -= cronStatusCounts.stale * 5;
  infraConfidence -= queuePressure * 0.5;
  if (failureVelocityRatio !== null && failureVelocityRatio >= 2) {
    infraConfidence -= 15;
  } else if (failuresLastHour >= 5) {
    infraConfidence -= 8;
  }
  infraConfidence = clamp(Math.round(infraConfidence), 0, 100);

  // ─── Automation reliability ─────────────────────────────────────
  // Find the automations cron job + the stuck automations queue.
  const automationsCron = cronHeartbeats.find((h) => h.jobName === "automations:run");
  const stuckAutomations = stuckQueues.find((q) => q.kind === "pending_automations_stuck");
  let automationReliability = 100;
  if (automationsCron) {
    if (automationsCron.status === "down") automationReliability -= 50;
    else if (automationsCron.status === "stale") automationReliability -= 25;
    if (automationsCron.failedRuns24h >= 3) automationReliability -= 15;
    else if (automationsCron.failedRuns24h >= 1) automationReliability -= 5;
  } else {
    automationReliability = 50; // job missing entirely
  }
  if (stuckAutomations) {
    automationReliability -= Math.min(30, stuckAutomations.count * 3);
  }
  automationReliability = clamp(Math.round(automationReliability), 0, 100);

  // ─── Incident severity ──────────────────────────────────────────
  let incidentSeverity = 0;
  incidentSeverity += cronStatusCounts.down * 20;
  incidentSeverity += criticalFailuresLastHour * 10;
  incidentSeverity += (stuckQueues.find((q) => q.kind === "pending_payment_backlog")?.count ?? 0) * 2;
  if (failureVelocityRatio !== null && failureVelocityRatio >= 3) {
    incidentSeverity += 20;
  }
  incidentSeverity = clamp(Math.round(incidentSeverity), 0, 100);

  // ─── Live throughput ────────────────────────────────────────────
  // Count cron heartbeats whose lastStartedAt is within the last 60 min.
  let liveThroughput = 0;
  for (const h of cronHeartbeats) {
    if (h.ageMinutes !== null && h.ageMinutes <= 60) liveThroughput++;
  }

  // ─── Platform status classifier ─────────────────────────────────
  let platformStatus: OpsPlatformStatus = "calm";
  if (
    cronStatusCounts.down >= 3 ||
    incidentSeverity >= 60 ||
    criticalFailuresLastHour >= 3
  ) {
    platformStatus = "critical";
  } else if (cronStatusCounts.down >= 1 || queuePressure >= 50 || incidentSeverity >= 30) {
    platformStatus = "stalled";
  } else if (
    cronStatusCounts.stale >= 2 ||
    queuePressure >= 20 ||
    (failureVelocityRatio !== null && failureVelocityRatio >= 2)
  ) {
    platformStatus = "degraded";
  } else if (liveThroughput >= 3 || failuresLastHour > 0) {
    platformStatus = "active";
  }

  return {
    platformStatus,
    cronHealthScore,
    queuePressure,
    failuresLastHour,
    failuresPrior23h,
    failureVelocityRatio,
    infraConfidence,
    automationReliability,
    incidentSeverity,
    liveThroughput,
    cronStatusCounts,
    stuckQueuesCount: stuckQueues.length,
    recentFailures24h: recentFailures.length,
    criticalFailuresLastHour,
  };
}

// ─── Deterministic ops insights ───────────────────────────────────

export type OpsInsight = {
  id: string;
  surface: "hero" | "cron" | "queue" | "failures";
  tone: "positive" | "neutral" | "warning" | "critical";
  label: string;
  detail?: string;
};

export function deriveOpsInsights(bundle: OpsDiagnosticsBundle, kpis: OpsMissionKpis): OpsInsight[] {
  const out: OpsInsight[] = [];

  // 1. Failure acceleration (last hour vs hourly average)
  if (kpis.failureVelocityRatio !== null && kpis.failureVelocityRatio >= 2 && kpis.failuresLastHour >= 5) {
    out.push({
      id: "failure_accel",
      surface: "failures",
      tone: kpis.failureVelocityRatio >= 3 ? "critical" : "warning",
      label: `Failure velocity ${kpis.failureVelocityRatio}× normal — ${kpis.failuresLastHour} in last hour`,
      detail: "Last-hour failure rate exceeds 23-hour hourly average. Investigate failure stream.",
    });
  }

  // 2. Cron degradation cluster — same job failing repeatedly
  const repeatedFailers = bundle.cronHeartbeats.filter((h) => h.failedRuns24h >= 3);
  if (repeatedFailers.length > 0) {
    out.push({
      id: "cron_repeated_failures",
      surface: "cron",
      tone: repeatedFailers.length >= 3 ? "critical" : "warning",
      label: `${repeatedFailers.length} cron job${repeatedFailers.length === 1 ? "" : "s"} with ≥3 failures in 24h`,
      detail: `Affected: ${repeatedFailers.map((r) => r.jobName).join(", ")}`,
    });
  }

  // 3. Queue pressure significant
  if (kpis.queuePressure >= 30) {
    out.push({
      id: "queue_pressure",
      surface: "queue",
      tone: kpis.queuePressure >= 60 ? "critical" : "warning",
      label: `Queue pressure ${kpis.queuePressure} — ${kpis.stuckQueuesCount} queue${kpis.stuckQueuesCount === 1 ? "" : "s"} backed up`,
      detail: "Each queue line weighted by kind × log(count). Drains via cron worker.",
    });
  }

  // 4. Healthy state reassurance
  if (
    kpis.platformStatus === "calm" &&
    kpis.cronHealthScore !== null &&
    kpis.cronHealthScore >= 95 &&
    kpis.stuckQueuesCount === 0
  ) {
    out.push({
      id: "platform_healthy",
      surface: "hero",
      tone: "positive",
      label: `Platform healthy — ${kpis.cronHealthScore}% cron jobs OK, 0 stuck queues`,
      detail: "All known cron jobs OK or running, no stuck queues, no critical failures.",
    });
  }

  // 5. Critical state explainer
  if (kpis.platformStatus === "critical") {
    const reasons: string[] = [];
    if (kpis.cronStatusCounts.down >= 3) reasons.push(`${kpis.cronStatusCounts.down} crons down`);
    if (kpis.criticalFailuresLastHour >= 3) reasons.push(`${kpis.criticalFailuresLastHour} crashes in 1h`);
    if (kpis.incidentSeverity >= 60) reasons.push(`incident severity ${kpis.incidentSeverity}`);
    out.push({
      id: "platform_critical",
      surface: "hero",
      tone: "critical",
      label: "Critical operational state — multiple signals firing",
      detail: reasons.join(" · "),
    });
  }

  // 6. Automation reliability
  if (kpis.automationReliability < 60) {
    out.push({
      id: "automation_degraded",
      surface: "cron",
      tone: kpis.automationReliability < 30 ? "critical" : "warning",
      label: `Automation reliability ${kpis.automationReliability} — degraded`,
      detail: "automations:run cron + pending_automations queue composite. Investigate stuck claims.",
    });
  }

  return out;
}
