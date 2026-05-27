/**
 * Platform Health Mission Control — pure composite scoring.
 *
 * Philosophy (strict, identical to ops-mission / diagnostics-reliability):
 *   • NO new SQL queries — derives EVERYTHING from the existing
 *     InfrastructureHealth + IntegrationsMatrix + CommsMonitoring payloads.
 *   • NO LLM. NO fake telemetry. NO fabricated uptime.
 *   • Deterministic functions of (status counts × failure counts ×
 *     queue sizes × tile values) — explainable line by line.
 *   • Pure module — types-only imports, no DB dep, client-safe.
 *
 * Hero scores (0-100, derived from the existing payloads):
 *   • globalHealthScore         — weighted composite of all axes
 *   • infrastructureConfidence  — % of infra cards in green state
 *   • integrationStability      — provider status × failure weighting
 *   • communicationReliability  — % of comm tiles in green state
 *   • operationalPressureScore  — composite of failure + queue signals
 *   • uptimeConfidence          — composite (1 - critical signal density)
 *
 * Live state classifier: calm / active / degraded / incident
 */

import type { InfrastructureHealth, HealthCard, HealthStatus } from "./health";
import type { IntegrationsMatrix, IntegrationProvider } from "./integrations";
import type { CommsMonitoring, CommsTile } from "./comms";

// ─── Client-safe types ────────────────────────────────────────────

export type PlatformOperationalStatus = "calm" | "active" | "degraded" | "incident";

export type PlatformHealthKpis = {
  /** Overall operational status classification. */
  operationalStatus: PlatformOperationalStatus;
  /** Overall global health 0-100 (higher = better). */
  globalHealthScore: number;
  /** Infrastructure confidence 0-100. NULL when no infra cards. */
  infrastructureConfidence: number | null;
  /** Integration stability 0-100. NULL when no providers. */
  integrationStability: number | null;
  /** Communication reliability 0-100. NULL when no comm tiles. */
  communicationReliability: number | null;
  /** Operational pressure 0-100 (higher = MORE pressure). */
  operationalPressureScore: number;
  /** Uptime confidence 0-100. */
  uptimeConfidence: number;
  /** Active incident count (red-status cards/providers/tiles). */
  activeIncidentCount: number;
  /** Raw counts for hero tile detail copy. */
  infraGreen: number;
  infraAmber: number;
  infraRed: number;
  infraTotal: number;
  providerHealthy: number;
  providerDegraded: number;
  providerCritical: number;
  providerTotal: number;
  commsGreen: number;
  commsAmber: number;
  commsRed: number;
  commsTotal: number;
};

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

// ─── Composite scoring ────────────────────────────────────────────

export function deriveHealthMission(args: {
  infra: InfrastructureHealth | null;
  integrations: IntegrationsMatrix | null;
  comms: CommsMonitoring | null;
}): PlatformHealthKpis {
  const { infra, integrations, comms } = args;

  // ─── Infrastructure axis ──────────────────────────────────────
  const infraCards: HealthCard[] = infra?.cards ?? [];
  const infraGreen = infraCards.filter((c) => c.status === "green").length;
  const infraAmber = infraCards.filter((c) => c.status === "amber").length;
  const infraRed = infraCards.filter((c) => c.status === "red").length;
  const infraTotal = infraCards.length;
  const infrastructureConfidence =
    infraTotal === 0
      ? null
      : Math.round(((infraGreen + 0.5 * infraAmber) / infraTotal) * 100);

  // ─── Integration axis ─────────────────────────────────────────
  const providers: IntegrationProvider[] = integrations?.providers ?? [];
  // Exclude not_configured providers from the denominator.
  const configuredProviders = providers.filter((p) => p.status !== "not_configured");
  const providerHealthy = configuredProviders.filter((p) => p.status === "healthy").length;
  const providerDegraded = configuredProviders.filter((p) => p.status === "degraded").length;
  const providerCritical = configuredProviders.filter((p) => p.status === "critical").length;
  const providerTotal = configuredProviders.length;
  const integrationStability =
    providerTotal === 0
      ? null
      : Math.round(((providerHealthy + 0.5 * providerDegraded) / providerTotal) * 100);

  // Sum of provider failure signals (used in pressure calc)
  const totalRefreshFailures = providers.reduce((s, p) => s + p.refreshFailures, 0);
  const totalWebhookFailures = providers.reduce((s, p) => s + p.webhookFailures, 0);
  const totalExpiredTokens = providers.reduce((s, p) => s + p.expiredTokens, 0);

  // ─── Communication axis ───────────────────────────────────────
  const commsTiles: CommsTile[] = comms?.tiles ?? [];
  const commsGreen = commsTiles.filter((t) => t.status === "green").length;
  const commsAmber = commsTiles.filter((t) => t.status === "amber").length;
  const commsRed = commsTiles.filter((t) => t.status === "red").length;
  const commsTotal = commsTiles.length;
  const communicationReliability =
    commsTotal === 0
      ? null
      : Math.round(((commsGreen + 0.5 * commsAmber) / commsTotal) * 100);

  // ─── Operational pressure (higher = MORE pressure) ───────────
  // Composite of red counts + failure counts.
  let operationalPressureScore = 0;
  operationalPressureScore += infraRed * 12;
  operationalPressureScore += infraAmber * 4;
  operationalPressureScore += providerCritical * 15;
  operationalPressureScore += providerDegraded * 5;
  operationalPressureScore += commsRed * 10;
  operationalPressureScore += commsAmber * 3;
  // Soft cap based on absolute failure counts
  if (totalRefreshFailures >= 10) operationalPressureScore += 10;
  if (totalWebhookFailures >= 5) operationalPressureScore += 10;
  if (totalExpiredTokens >= 10) operationalPressureScore += 5;
  operationalPressureScore = clamp(operationalPressureScore, 0, 100);

  // ─── Uptime confidence ────────────────────────────────────────
  // Starts at 100, subtracts critical-class signal density.
  const totalCriticals = infraRed + providerCritical + commsRed;
  const uptimeConfidence = clamp(
    100 -
      totalCriticals * 10 -
      Math.min(20, totalWebhookFailures * 2) -
      Math.min(15, totalRefreshFailures),
    0,
    100,
  );

  // ─── Global health (weighted composite, higher = better) ─────
  // Weights: infra 30% · integrations 30% · comms 25% · pressure 15%
  const infraComponent = infrastructureConfidence ?? 80;
  const integrationComponent = integrationStability ?? 80;
  const commsComponent = communicationReliability ?? 80;
  const pressureComponent = 100 - operationalPressureScore;
  const globalHealthScore = Math.round(
    infraComponent * 0.3 +
      integrationComponent * 0.3 +
      commsComponent * 0.25 +
      pressureComponent * 0.15,
  );

  // ─── Operational status classifier ───────────────────────────
  const activeIncidentCount = infraRed + providerCritical + commsRed;
  let operationalStatus: PlatformOperationalStatus = "calm";
  if (activeIncidentCount >= 2 || globalHealthScore < 60) {
    operationalStatus = "incident";
  } else if (
    activeIncidentCount >= 1 ||
    globalHealthScore < 75 ||
    operationalPressureScore >= 40
  ) {
    operationalStatus = "degraded";
  } else if (
    infraAmber + providerDegraded + commsAmber >= 2 ||
    operationalPressureScore >= 15
  ) {
    operationalStatus = "active";
  }

  return {
    operationalStatus,
    globalHealthScore,
    infrastructureConfidence,
    integrationStability,
    communicationReliability,
    operationalPressureScore,
    uptimeConfidence,
    activeIncidentCount,
    infraGreen,
    infraAmber,
    infraRed,
    infraTotal,
    providerHealthy,
    providerDegraded,
    providerCritical,
    providerTotal,
    commsGreen,
    commsAmber,
    commsRed,
    commsTotal,
  };
}

// ─── Deterministic insights ───────────────────────────────────────

export type HealthInsight = {
  id: string;
  surface: "hero" | "infra" | "integrations" | "comms";
  tone: "positive" | "neutral" | "warning" | "critical";
  label: string;
  detail?: string;
};

export function deriveHealthInsights(args: {
  infra: InfrastructureHealth | null;
  integrations: IntegrationsMatrix | null;
  comms: CommsMonitoring | null;
  kpis: PlatformHealthKpis;
}): HealthInsight[] {
  const { infra, integrations, comms, kpis } = args;
  const out: HealthInsight[] = [];

  // 1. Platform healthy reassurance
  if (
    kpis.operationalStatus === "calm" &&
    kpis.globalHealthScore >= 90 &&
    kpis.activeIncidentCount === 0
  ) {
    out.push({
      id: "platform_healthy",
      surface: "hero",
      tone: "positive",
      label: `Platform health ${kpis.globalHealthScore} — all systems nominal`,
      detail: `${kpis.infraGreen}/${kpis.infraTotal} infra · ${kpis.providerHealthy}/${kpis.providerTotal} integrations · ${kpis.commsGreen}/${kpis.commsTotal} comms green.`,
    });
  }

  // 2. Incident state
  if (kpis.operationalStatus === "incident") {
    const reasons: string[] = [];
    if (kpis.infraRed > 0) reasons.push(`${kpis.infraRed} infra red`);
    if (kpis.providerCritical > 0) reasons.push(`${kpis.providerCritical} provider critical`);
    if (kpis.commsRed > 0) reasons.push(`${kpis.commsRed} comms red`);
    out.push({
      id: "platform_incident",
      surface: "hero",
      tone: "critical",
      label: "Platform incident state — multiple critical signals",
      detail: reasons.join(" · "),
    });
  }

  // 3. Infrastructure degradation
  const infraCards = infra?.cards ?? [];
  const cronCards = infraCards.filter((c) =>
    c.key.toLowerCase().includes("cron") || c.label.toLowerCase().includes("cron"),
  );
  const cronStaleOrDown = cronCards.filter((c) => c.status !== "green");
  if (cronStaleOrDown.length > 0) {
    out.push({
      id: "cron_freshness",
      surface: "infra",
      tone: cronStaleOrDown.some((c) => c.status === "red") ? "critical" : "warning",
      label: `Cron freshness degrading — ${cronStaleOrDown.length} job${cronStaleOrDown.length === 1 ? "" : "s"} stale or down`,
      detail: cronStaleOrDown
        .slice(0, 3)
        .map((c) => c.label)
        .join(" · "),
    });
  }

  // 4. Integration provider-specific insights
  const providers = integrations?.providers ?? [];
  const oauthProviders = providers.filter((p) => p.key === "google" || p.key === "microsoft");
  const oauthFailures = oauthProviders.reduce((s, p) => s + p.refreshFailures, 0);
  if (oauthFailures >= 5) {
    out.push({
      id: "oauth_refresh_elevated",
      surface: "integrations",
      tone: oauthFailures >= 20 ? "critical" : "warning",
      label: `OAuth refresh failures elevated — ${oauthFailures} in window`,
      detail: "Google + Microsoft refresh attempts failing. Affected tenants may see calendar sync gaps.",
    });
  }

  const stripeProvider = providers.find((p) => p.key === "stripe");
  if (stripeProvider && stripeProvider.webhookFailures >= 5) {
    out.push({
      id: "stripe_webhook_pressure",
      surface: "integrations",
      tone: stripeProvider.webhookFailures >= 20 ? "critical" : "warning",
      label: `Stripe webhook failures ${stripeProvider.webhookFailures} — verify signature secret`,
      detail: "Sustained webhook signature mismatches typically indicate a secret rotation drift.",
    });
  } else if (stripeProvider && stripeProvider.status === "healthy" && stripeProvider.webhookFailures === 0) {
    out.push({
      id: "stripe_webhook_stable",
      surface: "integrations",
      tone: "positive",
      label: "Webhook reliability stable — Stripe signatures clean",
      detail: "Zero signature verification failures in the current window.",
    });
  }

  // 5. SES / comms reliability
  const sesProvider = providers.find((p) => p.key === "ses");
  if (sesProvider && sesProvider.status === "healthy") {
    out.push({
      id: "ses_stable",
      surface: "comms",
      tone: "positive",
      label: "SES delivery stability healthy",
      detail: "No suppression-list growth or bounce spikes in window.",
    });
  } else if (sesProvider && (sesProvider.status === "degraded" || sesProvider.status === "critical")) {
    out.push({
      id: "ses_degraded",
      surface: "comms",
      tone: sesProvider.status === "critical" ? "critical" : "warning",
      label: `SES delivery degraded — ${sesProvider.detail}`,
      detail: "Bounce / complaint signals elevated. Check sender identity verification.",
    });
  }

  // 6. Comms tile reliability — look for "failure rate" or "delivery rate"
  const failureTile = comms?.tiles.find(
    (t) =>
      t.label.toLowerCase().includes("fail") &&
      t.unit === "percent" &&
      t.value !== null &&
      Number(t.value) >= 5,
  );
  if (failureTile) {
    out.push({
      id: "delivery_failure_rate",
      surface: "comms",
      tone: Number(failureTile.value ?? 0) >= 15 ? "critical" : "warning",
      label: `${failureTile.label} ${failureTile.value}% — above threshold`,
      detail: failureTile.detail,
    });
  }

  // 7. Operational pressure callout
  if (kpis.operationalPressureScore >= 50) {
    out.push({
      id: "operational_pressure",
      surface: "hero",
      tone: kpis.operationalPressureScore >= 70 ? "critical" : "warning",
      label: `Operational pressure score ${kpis.operationalPressureScore}`,
      detail: "Composite of red/amber signals + integration failures + comms failures.",
    });
  }

  return out;
}
