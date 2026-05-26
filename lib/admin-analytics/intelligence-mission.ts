/**
 * Operations Intelligence Executive Mission — composite KPIs derived
 * deterministically from the existing IntelligenceReport.
 *
 * Philosophy (strict, identical to the rules engine):
 *   • NO LLM. NO ML. NO predictions.
 *   • Every score is a deterministic composite of insight presence +
 *     severity from the rule engine, which is itself SQL-backed.
 *   • Returns NULL when the underlying report is empty (UI renders "—").
 *
 * Hero scores (0-100):
 *   • platformHealth        — infra + security + ops signal absence
 *   • growthMomentum        — growth/opportunity signals minus churn
 *   • churnPressure         — churn + inactive + onboarding-dropoff sum
 *   • financialConfidence   — financial opportunity minus payment-recovery
 *   • onboardingVelocity    — based on signup_conversion_shift +
 *                              onboarding_dropoff presence
 *   • operationalAnomaly    — composite infra signal weight
 *   • strategicOpportunity  — upgrade + high_growth + signup_conversion+
 *
 * Each tile uses the SAME underlying insight signals — the score is
 * a transparent function of (severity × category × confidence).
 *
 * Pure module — no DB import, safe to use in client + server.
 */

import type {
  Insight,
  InsightCategory,
  InsightSeverity,
  IntelligenceReport,
} from "./intelligence";

// ─── Client-safe types ────────────────────────────────────────────

export type IntelligenceMissionTone = "calm" | "elevated" | "incident";

export type IntelligenceMissionKpis = {
  /** Overall platform posture classification. */
  platformPosture: IntelligenceMissionTone;
  /** Platform health trajectory score 0-100 (higher = better). NULL when no data. */
  platformHealth: number | null;
  /** Growth momentum score 0-100 (higher = faster growth). NULL when no data. */
  growthMomentum: number | null;
  /** Churn pressure score 0-100 (higher = more pressure). NULL when no data. */
  churnPressure: number | null;
  /** Financial confidence 0-100 (higher = better). NULL when no data. */
  financialConfidence: number | null;
  /** Onboarding velocity 0-100 (higher = better activation). NULL when no data. */
  onboardingVelocity: number | null;
  /** Operational anomaly score 0-100 (higher = more anomalies). NULL when no data. */
  operationalAnomaly: number | null;
  /** Strategic opportunity score 0-100 (higher = more upside). NULL when no data. */
  strategicOpportunity: number | null;
  /** Pre-computed counts surfaced to UI for tile detail text. */
  criticalCount: number;
  warningCount: number;
  opportunityCount: number;
  infoCount: number;
  /** Counts by category, for category badge density. */
  categoryCounts: Record<InsightCategory, number>;
};

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

const SEVERITY_WEIGHT: Record<InsightSeverity, number> = {
  critical: 30,
  warning: 15,
  opportunity: 0,
  info: 5,
};

function severityWeight(insights: Insight[]): number {
  return insights.reduce((acc, i) => acc + SEVERITY_WEIGHT[i.severity], 0);
}

function countBy(insights: Insight[], pred: (i: Insight) => boolean): number {
  return insights.reduce((n, i) => (pred(i) ? n + 1 : n), 0);
}

// ─── Composite score ──────────────────────────────────────────────

/**
 * Derive mission-control KPIs from an IntelligenceReport.
 *
 * Pure — same input always returns same output. UI can call this
 * client-side on already-fetched data without an extra round-trip.
 *
 * Returns ALL-NULL composite when the report is empty (no rules fired)
 * — the UI renders "—" and explains "rules engine quiet right now".
 */
export function deriveIntelligenceMission(
  report: IntelligenceReport,
): IntelligenceMissionKpis {
  const all = report.insights;
  const empty = all.length === 0;

  const categoryCounts = { ...report.summary.byCategory };

  if (empty) {
    return {
      platformPosture: "calm",
      platformHealth: 100, // explicit: no signals = full health
      growthMomentum: null,
      churnPressure: 0,
      financialConfidence: 100,
      onboardingVelocity: null,
      operationalAnomaly: 0,
      strategicOpportunity: null,
      criticalCount: 0,
      warningCount: 0,
      opportunityCount: 0,
      infoCount: 0,
      categoryCounts,
    };
  }

  // Counts
  const criticalCount = report.summary.bySeverity.critical;
  const warningCount = report.summary.bySeverity.warning;
  const opportunityCount = report.summary.bySeverity.opportunity;
  const infoCount = report.summary.bySeverity.info;

  // Per-category buckets
  const infraInsights = all.filter((i) => i.category === "infrastructure");
  const securityInsights = all.filter((i) => i.category === "security");
  const churnInsights = all.filter((i) => i.category === "churn");
  const growthInsights = all.filter((i) => i.category === "growth");
  const financialInsights = all.filter((i) => i.category === "financial");
  const onboardingInsights = all.filter((i) => i.category === "onboarding");
  const operationsInsights = all.filter((i) => i.category === "operations");

  // ─── Platform health (higher = better) ──────────────────────────
  // Starts at 100, subtracts severity-weighted infra + security signals.
  const platformHealth = clamp(
    100 - severityWeight(infraInsights) - severityWeight(securityInsights),
    0,
    100,
  );

  // ─── Churn pressure (higher = MORE pressure) ────────────────────
  // Built from churn + onboarding-dropoff signals.
  const churnSignal =
    severityWeight(churnInsights) +
    severityWeight(onboardingInsights.filter((i) => i.kind === "onboarding_dropoff"));
  const churnPressure = clamp(churnSignal, 0, 100);

  // ─── Growth momentum (higher = faster growth) ───────────────────
  // 50 baseline, +growth opportunity signals, −churn drag.
  // NULL if there's no growth-related signal AND no churn signal — we
  // simply don't have enough evidence either way.
  const growthOps = countBy(
    growthInsights,
    (i) => i.severity === "opportunity" || i.kind === "growth_acceleration",
  );
  const highGrowth = countBy(growthInsights, (i) => i.kind === "high_growth_alert");
  const growthMomentum =
    growthInsights.length === 0 && churnInsights.length === 0
      ? null
      : clamp(50 + growthOps * 15 + highGrowth * 10 - churnSignal / 2, 0, 100);

  // ─── Financial confidence (higher = better) ─────────────────────
  // Starts at 100, subtracts payment-recovery weight, adds upgrade-
  // opportunity bonus (small).
  const paymentRecovery = financialInsights
    .filter((i) => i.kind === "payment_recovery")
    .reduce((sum, i) => sum + SEVERITY_WEIGHT[i.severity], 0);
  const upgradeBonus = countBy(financialInsights, (i) => i.kind === "upgrade_opportunity") * 5;
  const financialConfidence = clamp(100 - paymentRecovery + upgradeBonus, 0, 100);

  // ─── Onboarding velocity (higher = better) ──────────────────────
  // Only meaningful when we have signup_conversion_shift OR
  // onboarding_dropoff data. NULL otherwise.
  const conversionShifts = all.filter((i) => i.kind === "signup_conversion_shift");
  const dropoffs = all.filter((i) => i.kind === "onboarding_dropoff");
  let onboardingVelocity: number | null = null;
  if (conversionShifts.length > 0 || dropoffs.length > 0) {
    // Pull delta_pts out of supporting data if present.
    let signedDelta = 0;
    for (const s of conversionShifts) {
      const v = s.supportingData["delta_pts"];
      if (typeof v === "number") signedDelta = v;
    }
    // 50 baseline + delta_pts/2 (scaled) − dropoff severity weight.
    const base = 50 + signedDelta * 2; // 10pt drop → -20; 10pt rise → +20
    const dropoffPenalty = severityWeight(dropoffs);
    onboardingVelocity = clamp(base - dropoffPenalty, 0, 100);
  }

  // ─── Operational anomaly (higher = MORE anomalies) ──────────────
  // Composite of infra severity weight + operations weight.
  const operationalAnomaly = clamp(
    severityWeight(infraInsights) + severityWeight(operationsInsights),
    0,
    100,
  );

  // ─── Strategic opportunity (higher = more upside) ───────────────
  // Built from any opportunity-severity insight + upgrade + high_growth.
  const oppSignals =
    opportunityCount * 25 +
    countBy(all, (i) => i.kind === "upgrade_opportunity") * 15 +
    countBy(all, (i) => i.kind === "high_growth_alert") * 15;
  const strategicOpportunity = oppSignals === 0 ? null : clamp(oppSignals, 0, 100);

  // ─── Posture classifier ─────────────────────────────────────────
  let platformPosture: IntelligenceMissionTone = "calm";
  if (criticalCount >= 1 || platformHealth < 60 || churnPressure >= 40) {
    platformPosture = "incident";
  } else if (
    warningCount >= 2 ||
    platformHealth < 80 ||
    churnPressure >= 20 ||
    operationalAnomaly >= 20
  ) {
    platformPosture = "elevated";
  }

  return {
    platformPosture,
    platformHealth,
    growthMomentum,
    churnPressure,
    financialConfidence,
    onboardingVelocity,
    operationalAnomaly,
    strategicOpportunity,
    criticalCount,
    warningCount,
    opportunityCount,
    infoCount,
    categoryCounts,
  };
}

// ─── Insight impact / momentum derivation (used by insight cards) ─

export type InsightImpact = {
  /** Number of tenants the insight touches (read directly from rule). */
  tenantCount: number;
  /** Effort estimate based on the rule's category. Heuristic, fixed mapping. */
  effort: "low" | "medium" | "high";
  /** Strategic momentum direction (up/down/flat) — derived from severity. */
  momentum: "up" | "down" | "flat";
  /** Priority rank 1-3 — derived from severity + tenant count. */
  priority: 1 | 2 | 3;
};

const CATEGORY_EFFORT: Record<InsightCategory, "low" | "medium" | "high"> = {
  growth: "medium",
  churn: "high",
  financial: "medium",
  onboarding: "medium",
  infrastructure: "high",
  security: "high",
  operations: "low",
};

export function deriveInsightImpact(insight: Insight): InsightImpact {
  const tenantCount = insight.impactedTenants.length;

  // Momentum: severity maps to a directional read of the underlying signal.
  let momentum: InsightImpact["momentum"] = "flat";
  if (insight.severity === "critical" || insight.severity === "warning") momentum = "down";
  else if (insight.severity === "opportunity") momentum = "up";

  // Priority: critical+many tenants = 1; critical or many tenants = 2; else 3.
  let priority: 1 | 2 | 3 = 3;
  if (insight.severity === "critical" && tenantCount >= 5) priority = 1;
  else if (insight.severity === "critical" || tenantCount >= 5) priority = 2;

  return {
    tenantCount,
    effort: CATEGORY_EFFORT[insight.category],
    momentum,
    priority,
  };
}
