/**
 * Simulation Mission Control — pure composite scoring + scenario
 * intelligence for the /admin/dev/simulation chaos lab.
 *
 * Philosophy (strict):
 *   • Operates ONLY on the synthetic-footprint summary already provided
 *     by getSimulationStatus(). No new DB queries. No real-data reads.
 *   • Pure module — types-only (no DB) — safe for client + server.
 *   • Deterministic — no randomness, no LLM, no fabricated signals.
 *   • Returns NULL when uncomputable (UI renders "—").
 *
 * Hero scores (0-100, derived from synthetic footprint):
 *   • simulationIntensity       — overall synthetic load
 *   • realismScore              — coverage of tenant/user/booking/audit signals
 *   • operationalCoverage       — % of dashboards likely populated by current footprint
 *   • syntheticFootprintHealth  — composite of marker safety + coverage
 *   • telemetryVelocity         — audit log volume relative to tenant count
 *   • syntheticLoadScore        — composite (intensity × velocity)
 *   • safetyConfidence          — synthetic-only verification + cleanup guarantees
 *
 * ALL synthetic. No real customer data is ever touched by this module.
 */

// ─── Client-safe types ────────────────────────────────────────────

export type SimulationLabStatus =
  | "idle" // no synthetic data
  | "warming" // small footprint
  | "active" // healthy operational scenario
  | "stress" // heavy footprint
  | "enterprise"; // maximum simulated load

export type SimulationFootprint = {
  tenants: number;
  users: number;
  bookings: number;
  auditLogs: number;
};

export type SimulationMissionKpis = {
  /** Lab status classification. */
  labStatus: SimulationLabStatus;
  /** Overall simulation intensity 0-100. */
  simulationIntensity: number;
  /** Realism score 0-100 (signal coverage). */
  realismScore: number;
  /** % of dashboards meaningfully populated. */
  operationalCoverage: number;
  /** Synthetic footprint health 0-100. */
  syntheticFootprintHealth: number;
  /** Audit log velocity (rows per tenant). */
  telemetryVelocity: number;
  /** Composite synthetic load 0-100. */
  syntheticLoadScore: number;
  /** Safety confidence 0-100 (always 100 when seeding enabled — marker design). */
  safetyConfidence: number;
  /** Total synthetic entities. */
  totalEntities: number;
  /** Active scenario count (1 if any footprint exists, else 0). */
  activeScenarioCount: number;
  /** Estimated tier label. */
  estimatedTier: "none" | "Light" | "Medium" | "Heavy" | "Enterprise";
};

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ─── Composite scoring ────────────────────────────────────────────

/**
 * Derive mission-control KPIs from the synthetic footprint.
 *
 * Pure — same input always returns same output. Safe to compute
 * client-side from the API status response.
 */
export function deriveSimulationMission(
  footprint: SimulationFootprint,
  enabled: boolean,
): SimulationMissionKpis {
  const { tenants, users, bookings, auditLogs } = footprint;
  const totalEntities = tenants + users + bookings + auditLogs;

  // ─── Estimated tier (matches the MODES table) ──────────────────
  let estimatedTier: SimulationMissionKpis["estimatedTier"] = "none";
  if (tenants >= 40) estimatedTier = "Enterprise";
  else if (tenants >= 15) estimatedTier = "Heavy";
  else if (tenants >= 6) estimatedTier = "Medium";
  else if (tenants >= 1) estimatedTier = "Light";

  // ─── Lab status classifier ─────────────────────────────────────
  let labStatus: SimulationLabStatus = "idle";
  if (tenants >= 40) labStatus = "enterprise";
  else if (tenants >= 15) labStatus = "stress";
  else if (tenants >= 6) labStatus = "active";
  else if (tenants >= 1) labStatus = "warming";

  // ─── Simulation intensity (footprint magnitude) ────────────────
  // Logarithmic scale so a 50-tenant enterprise doesn't pin a 3-tenant
  // light run to "0%". Caps at 50 tenants = 100 intensity.
  const simulationIntensity =
    tenants === 0 ? 0 : Math.round(clamp((Math.log10(tenants + 1) / Math.log10(51)) * 100, 0, 100));

  // ─── Realism score (signal-coverage breadth) ───────────────────
  // 4 signal axes — full points when each is present at expected ratio.
  const realismAxes: number[] = [
    tenants > 0 ? 25 : 0, // tenant base
    users > 0 ? Math.min(25, (users / Math.max(1, tenants * 2)) * 25) : 0, // users per tenant
    bookings > 0 ? Math.min(25, (bookings / Math.max(1, tenants * 30)) * 25) : 0, // bookings per tenant
    auditLogs > 0 ? Math.min(25, (auditLogs / Math.max(1, tenants * 50)) * 25) : 0, // audit per tenant
  ];
  const realismScore = Math.round(realismAxes.reduce((s, n) => s + n, 0));

  // ─── Operational coverage (% of admin dashboards populated) ────
  // 10 dashboards: revenue, finance, activity, intelligence, security,
  // ops, diagnostics, tenants, customers, pricing.
  // Each becomes "populated" at different footprint thresholds.
  let dashboardsPopulated = 0;
  if (tenants > 0) dashboardsPopulated += 1; // tenants
  if (tenants >= 3) dashboardsPopulated += 1; // revenue
  if (tenants >= 3) dashboardsPopulated += 1; // finance
  if (bookings > 0) dashboardsPopulated += 1; // customers
  if (auditLogs > 0) dashboardsPopulated += 1; // activity
  if (auditLogs >= 50) dashboardsPopulated += 1; // security
  if (auditLogs >= 100) dashboardsPopulated += 1; // intelligence
  if (tenants >= 1) dashboardsPopulated += 1; // diagnostics (schema check works regardless)
  if (auditLogs > 0) dashboardsPopulated += 1; // ops (cron observability adjacent)
  if (tenants >= 1) dashboardsPopulated += 1; // pricing
  const operationalCoverage = Math.round((dashboardsPopulated / 10) * 100);

  // ─── Synthetic footprint health ────────────────────────────────
  // Always healthy when seeding enabled (marker safety design). When
  // disabled but footprint exists, dropping to "monitoring".
  const syntheticFootprintHealth = !enabled && totalEntities > 0 ? 70 : enabled ? 100 : 80;

  // ─── Telemetry velocity (audit per tenant) ─────────────────────
  const telemetryVelocity = tenants === 0 ? 0 : Math.round(auditLogs / tenants);

  // ─── Synthetic load score (composite) ──────────────────────────
  const syntheticLoadScore = Math.round(
    simulationIntensity * 0.5 + Math.min(100, telemetryVelocity) * 0.3 + operationalCoverage * 0.2,
  );

  // ─── Safety confidence ─────────────────────────────────────────
  // Pegged to marker architecture: when seeding is enabled, cleanup
  // guarantees are intact (every row carries SEEDED_BY_MARKER). When
  // disabled, slightly lower because no new writes can be tracked,
  // but existing markers still protect any prior synthetic rows.
  const safetyConfidence = enabled ? 100 : 95;

  return {
    labStatus,
    simulationIntensity,
    realismScore,
    operationalCoverage,
    syntheticFootprintHealth,
    telemetryVelocity,
    syntheticLoadScore,
    safetyConfidence,
    totalEntities,
    activeScenarioCount: tenants > 0 ? 1 : 0,
    estimatedTier,
  };
}

// ─── Deterministic insights ───────────────────────────────────────

export type SimulationInsight = {
  id: string;
  surface: "hero" | "scenarios" | "injectors" | "archetypes";
  tone: "positive" | "neutral" | "warning" | "info";
  label: string;
  detail?: string;
};

export function deriveSimulationInsights(
  kpis: SimulationMissionKpis,
  enabled: boolean,
): SimulationInsight[] {
  const out: SimulationInsight[] = [];

  if (!enabled) {
    out.push({
      id: "lab_disabled",
      surface: "hero",
      tone: "warning",
      label: "Lab disabled — ALLOW_DEV_SIMULATION not set",
      detail: "Set the env flag and restart pm2 to enable scenario writes.",
    });
    return out;
  }

  if (kpis.labStatus === "idle") {
    out.push({
      id: "lab_idle",
      surface: "scenarios",
      tone: "info",
      label: "No active scenario — pick a tier below to populate dashboards",
      detail: "Light (3 tenants) is recommended for first run. Enterprise (50) for stress demos.",
    });
    return out;
  }

  if (kpis.operationalCoverage >= 80) {
    out.push({
      id: "coverage_high",
      surface: "hero",
      tone: "positive",
      label: `Operational coverage ${kpis.operationalCoverage}% — most dashboards populated`,
      detail: "Synthetic footprint is wide enough for full demo + observability testing.",
    });
  }

  if (kpis.telemetryVelocity >= 100 && kpis.totalEntities > 0) {
    out.push({
      id: "telemetry_dense",
      surface: "hero",
      tone: "positive",
      label: `Telemetry velocity ${kpis.telemetryVelocity} events/tenant — rich audit stream`,
      detail: "Activity / security / intelligence dashboards will read meaningful signal.",
    });
  }

  if (kpis.labStatus === "enterprise") {
    out.push({
      id: "enterprise_scale",
      surface: "scenarios",
      tone: "warning",
      label: `Enterprise simulation active — nearing snapshot computation thresholds`,
      detail: `${kpis.totalEntities} synthetic entities. Snapshot aggregations may take longer to compute on this footprint.`,
    });
  }

  if (kpis.realismScore >= 90) {
    out.push({
      id: "realism_high",
      surface: "archetypes",
      tone: "positive",
      label: `Realism score ${kpis.realismScore} — all signal axes present`,
      detail: "Tenant + user + booking + audit signals each above expected per-tenant baseline.",
    });
  }

  if (kpis.realismScore < 50 && kpis.totalEntities > 0) {
    out.push({
      id: "realism_low",
      surface: "archetypes",
      tone: "info",
      label: `Realism score ${kpis.realismScore} — sparse telemetry`,
      detail: "Run a heavier tier or inject failure bursts to populate additional signal axes.",
    });
  }

  return out;
}

// ─── Scenario tier metadata (client-safe) ────────────────────────

export type ScenarioTier = {
  id: "light" | "medium" | "heavy" | "enterprise";
  label: string;
  detail: string;
  /** Approx tenant count for visual sizing. */
  tenantCount: number;
  /** Days of synthetic history. */
  historyDays: number;
  /** Approx event volume estimate (for visual indicator bar). */
  eventVolumeEstimate: number;
  /** Visual intensity 0-100 for the load bar. */
  intensityPct: number;
  /** Tone for visual identity. */
  tone: "info" | "primary" | "warning" | "critical";
};

export const SCENARIO_TIERS: ScenarioTier[] = [
  {
    id: "light",
    label: "Light",
    detail: "3 tenants · 30d history",
    tenantCount: 3,
    historyDays: 30,
    eventVolumeEstimate: 200,
    intensityPct: 20,
    tone: "info",
  },
  {
    id: "medium",
    label: "Medium",
    detail: "8 tenants · 60d history",
    tenantCount: 8,
    historyDays: 60,
    eventVolumeEstimate: 1200,
    intensityPct: 45,
    tone: "primary",
  },
  {
    id: "heavy",
    label: "Heavy",
    detail: "20 tenants · 90d history",
    tenantCount: 20,
    historyDays: 90,
    eventVolumeEstimate: 4500,
    intensityPct: 75,
    tone: "warning",
  },
  {
    id: "enterprise",
    label: "Enterprise",
    detail: "50 tenants · 90d history",
    tenantCount: 50,
    historyDays: 90,
    eventVolumeEstimate: 12000,
    intensityPct: 100,
    tone: "critical",
  },
];

// ─── Injector metadata (client-safe) ─────────────────────────────

export type InjectorMeta = {
  id: string;
  label: string;
  detail: string;
  category: "churn" | "growth" | "delivery" | "integration" | "infrastructure";
  /** Blast radius — which dashboards will surface the effect. */
  blastRadius: readonly string[];
  /** Visual intensity bar 0-100. */
  intensityPct: number;
};

export const INJECTOR_META: InjectorMeta[] = [
  {
    id: "churn_spike",
    label: "Churn spike",
    detail: "3–5 subscription cancel events in last hour",
    category: "churn",
    blastRadius: ["revenue", "finance", "intelligence"],
    intensityPct: 55,
  },
  {
    id: "booking_spike",
    label: "Booking spike",
    detail: "30–60 booking.created events in last hour",
    category: "growth",
    blastRadius: ["revenue", "activity", "operations"],
    intensityPct: 80,
  },
  {
    id: "reminder_failures",
    label: "Reminder failures",
    detail: "15–25 failed reminder sends in last hour",
    category: "delivery",
    blastRadius: ["activity", "ops", "diagnostics"],
    intensityPct: 65,
  },
  {
    id: "oauth_failures",
    label: "OAuth failures",
    detail: "5–10 oauth refresh failures in last hour",
    category: "integration",
    blastRadius: ["security", "activity", "intelligence"],
    intensityPct: 50,
  },
  {
    id: "webhook_flood",
    label: "Webhook flood",
    detail: "20–40 stripe webhook errors in last hour",
    category: "infrastructure",
    blastRadius: ["ops", "security", "finance"],
    intensityPct: 90,
  },
];
