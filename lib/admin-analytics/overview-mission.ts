/**
 * Super Admin Overview — pure executive composite scoring.
 *
 * Philosophy (strict, identical to revenue-/finance-/health-mission):
 *   • NO new SQL queries — derives EVERYTHING from the KpiBundle
 *     that's already computed on the page.
 *   • NO LLM. NO fabricated growth. NO fake telemetry.
 *   • Deterministic functions of (kpi values × deltas) — explainable.
 *   • Pure module — types-only imports, client-safe.
 *
 * Hero scores (0-100):
 *   • businessHealthScore        — weighted composite of all axes
 *   • revenueMomentum            — derived from MRR delta + booking growth
 *   • growthTrajectory           — signup velocity + tenant velocity
 *   • tenantExpansionVelocity    — active paid + booking volume signal
 *   • operationalConfidence      — email delivery + calendar sync composite
 *   • platformStability          — composite (lower-is-better signals)
 *   • strategicOpportunityScore  — opportunity-signal density
 */

import type { KpiBundle, KpiResult } from "./kpis";

// ─── Client-safe types ────────────────────────────────────────────

export type OverviewOperationalStatus = "calm" | "active" | "growing" | "elevated" | "incident";

export type OverviewMissionKpis = {
  operationalStatus: OverviewOperationalStatus;
  businessHealthScore: number;
  /** Revenue momentum 0-100. NULL when no MRR delta data. */
  revenueMomentum: number | null;
  /** Growth trajectory 0-100. NULL when no signup data. */
  growthTrajectory: number | null;
  /** Tenant expansion velocity 0-100. */
  tenantExpansionVelocity: number;
  /** Operational confidence 0-100. NULL when delivery/sync metrics empty. */
  operationalConfidence: number | null;
  /** Platform stability 0-100. */
  platformStability: number;
  /** Strategic opportunity 0-100. NULL when no signal. */
  strategicOpportunityScore: number | null;
  /** Counts surfaced to hero tile detail text. */
  activeIncidents: number;
};

// ─── Helpers ──────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function safeValue(k: KpiResult | undefined): number | null {
  if (!k || k.error) return null;
  return k.value;
}

function safeDelta(k: KpiResult | undefined): number | null {
  if (!k || k.error) return null;
  return k.deltaPct;
}

// ─── Composite scoring ────────────────────────────────────────────

export function deriveOverviewMission(args: {
  kpis: KpiBundle | null;
  /** Synthetic + DB-derived inputs from the page itself. */
  context: {
    totalTenants: number;
    totalUsers: number;
    totalBookings: number;
    bookings7d: number;
    emailSent7d: number;
    emailFailures7d: number;
    expiredGoogleCount: number;
    mrrCents: number;
    trialingNow: number;
    pastDueNow: number;
    tenantsNew30d: number;
    trialConversionPct: number | null;
  };
}): OverviewMissionKpis {
  const { kpis, context } = args;

  // ─── Revenue momentum ────────────────────────────────────────
  const mrrDelta = safeDelta(kpis?.totalMrr);
  const bookingGrowthDelta = safeValue(kpis?.bookingGrowthPct);
  let revenueMomentum: number | null = null;
  if (mrrDelta !== null || bookingGrowthDelta !== null) {
    // Center at 50, +1 pt per 1% growth, capped.
    const mrrPoints = mrrDelta !== null ? clamp(mrrDelta, -50, 50) : 0;
    const bookingPoints =
      bookingGrowthDelta !== null ? clamp(bookingGrowthDelta * 0.4, -20, 30) : 0;
    revenueMomentum = clamp(Math.round(50 + mrrPoints + bookingPoints), 0, 100);
  }

  // ─── Growth trajectory ───────────────────────────────────────
  const signups7d = safeValue(kpis?.newSignups7d) ?? 0;
  const signups30d = safeValue(kpis?.newSignups30d) ?? 0;
  const signupDelta = safeDelta(kpis?.newSignups7d);
  let growthTrajectory: number | null = null;
  if (signups30d > 0 || context.tenantsNew30d > 0) {
    // Base from absolute volume + delta lift.
    const volumeScore = Math.min(50, signups30d * 3);
    const velocityScore = signupDelta !== null ? clamp(signupDelta * 0.6, -25, 50) : 0;
    growthTrajectory = clamp(Math.round(50 + velocityScore + Math.min(25, volumeScore - 25)), 0, 100);
  }

  // ─── Tenant expansion velocity ───────────────────────────────
  const activePaid = safeValue(kpis?.activePaidTenants) ?? 0;
  const bookingsTotal = safeValue(kpis?.totalBookings) ?? context.totalBookings;
  // Composite: active paid scale + booking velocity (per-tenant).
  const perTenantBookings = activePaid > 0 ? bookingsTotal / activePaid : 0;
  const tenantExpansionVelocity = clamp(
    Math.round(
      Math.min(50, activePaid * 2) + Math.min(50, perTenantBookings * 1.5),
    ),
    0,
    100,
  );

  // ─── Operational confidence ──────────────────────────────────
  const emailSuccess = safeValue(kpis?.emailDeliverySuccessPct);
  const calendarSync = safeValue(kpis?.calendarSyncHealthPct);
  let operationalConfidence: number | null = null;
  if (emailSuccess !== null || calendarSync !== null) {
    const components: number[] = [];
    if (emailSuccess !== null) components.push(emailSuccess);
    if (calendarSync !== null) components.push(calendarSync);
    operationalConfidence = Math.round(components.reduce((s, n) => s + n, 0) / components.length);
  }

  // ─── Platform stability ──────────────────────────────────────
  // Start at 100, subtract instability signals.
  const failedPayments = safeValue(kpis?.failedPayments30d) ?? 0;
  const churn = safeValue(kpis?.churnedThisMonth) ?? 0;
  let platformStability = 100;
  platformStability -= Math.min(30, failedPayments * 2);
  platformStability -= Math.min(20, churn * 3);
  platformStability -= Math.min(20, context.expiredGoogleCount * 2);
  platformStability -= Math.min(15, context.pastDueNow * 3);
  // Email failure ratio penalty
  const totalEmail = context.emailSent7d + context.emailFailures7d;
  if (totalEmail >= 50) {
    const failPct = (context.emailFailures7d / totalEmail) * 100;
    if (failPct >= 5) platformStability -= Math.min(15, failPct);
  }
  platformStability = clamp(Math.round(platformStability), 0, 100);

  // ─── Strategic opportunity ──────────────────────────────────
  // Trial conversion + trialing pool + signup velocity = upside.
  const trialConv = context.trialConversionPct;
  const trialPool = context.trialingNow;
  let strategicOpportunityScore: number | null = null;
  if (trialConv !== null || trialPool > 0 || signups7d > 0) {
    const convScore = trialConv !== null ? clamp(trialConv, 0, 50) : 0;
    const poolScore = Math.min(30, trialPool * 3);
    const velocityScore = Math.min(20, signups7d * 4);
    strategicOpportunityScore = clamp(
      Math.round(convScore + poolScore + velocityScore),
      0,
      100,
    );
  }

  // ─── Business health score (weighted composite) ─────────────
  // revenue 25% · growth 25% · ops 20% · stability 20% · expansion 10%
  const revenueComponent = revenueMomentum ?? 70;
  const growthComponent = growthTrajectory ?? 70;
  const opsComponent = operationalConfidence ?? 80;
  const stabilityComponent = platformStability;
  const expansionComponent = tenantExpansionVelocity;
  const businessHealthScore = Math.round(
    revenueComponent * 0.25 +
      growthComponent * 0.25 +
      opsComponent * 0.2 +
      stabilityComponent * 0.2 +
      expansionComponent * 0.1,
  );

  // ─── Active incidents ───────────────────────────────────────
  const activeIncidents =
    (context.pastDueNow > 0 ? 1 : 0) +
    (context.expiredGoogleCount >= 3 ? 1 : 0) +
    (totalEmail >= 50 && context.emailFailures7d / Math.max(1, totalEmail) >= 0.05 ? 1 : 0) +
    (failedPayments >= 5 ? 1 : 0);

  // ─── Operational status classifier ──────────────────────────
  let operationalStatus: OverviewOperationalStatus = "calm";
  if (activeIncidents >= 2 || businessHealthScore < 55) {
    operationalStatus = "incident";
  } else if (activeIncidents >= 1 || platformStability < 75) {
    operationalStatus = "elevated";
  } else if (
    (growthTrajectory !== null && growthTrajectory >= 70) ||
    (revenueMomentum !== null && revenueMomentum >= 70)
  ) {
    operationalStatus = "growing";
  } else if (signups7d > 0 || context.bookings7d > 50) {
    operationalStatus = "active";
  }

  return {
    operationalStatus,
    businessHealthScore,
    revenueMomentum,
    growthTrajectory,
    tenantExpansionVelocity,
    operationalConfidence,
    platformStability,
    strategicOpportunityScore,
    activeIncidents,
  };
}

// ─── Deterministic storytelling ──────────────────────────────────

export type OverviewInsight = {
  id: string;
  surface: "hero" | "revenue" | "plans" | "footprint" | "ops";
  tone: "positive" | "neutral" | "warning" | "critical";
  label: string;
  detail?: string;
};

export function deriveOverviewInsights(args: {
  kpis: KpiBundle | null;
  mission: OverviewMissionKpis;
  context: {
    bookings7d: number;
    emailSent7d: number;
    emailFailures7d: number;
    expiredGoogleCount: number;
    pastDueNow: number;
    trialingNow: number;
    trialConversionPct: number | null;
  };
}): OverviewInsight[] {
  const { kpis, mission, context } = args;
  const out: OverviewInsight[] = [];

  // 1. Revenue momentum
  const mrrDelta = safeDelta(kpis?.totalMrr);
  if (mrrDelta !== null && Math.abs(mrrDelta) >= 5) {
    out.push({
      id: "revenue_momentum",
      surface: "revenue",
      tone: mrrDelta > 0 ? "positive" : "warning",
      label: `Revenue momentum ${mrrDelta > 0 ? "accelerating" : "softening"} ${mrrDelta > 0 ? "+" : ""}${mrrDelta}%`,
      detail: "MRR delta vs prior period.",
    });
  }

  // 2. Paid tenant growth
  const paidTenantsDelta = safeDelta(kpis?.activePaidTenants);
  if (paidTenantsDelta !== null && Math.abs(paidTenantsDelta) >= 5) {
    out.push({
      id: "paid_tenant_growth",
      surface: "plans",
      tone: paidTenantsDelta > 0 ? "positive" : "warning",
      label: `Paid tenant base ${paidTenantsDelta > 0 ? "expanding" : "contracting"} ${paidTenantsDelta > 0 ? "+" : ""}${paidTenantsDelta}%`,
      detail: "Active paid subscriptions period-over-period.",
    });
  } else if (kpis?.activePaidTenants?.value !== null && kpis?.activePaidTenants?.value !== undefined && (kpis.activePaidTenants.value as number) > 0) {
    out.push({
      id: "paid_tenant_stable",
      surface: "plans",
      tone: "neutral",
      label: "Paid tenant growth stable",
      detail: "No material change in the active paid base.",
    });
  }

  // 3. Booking volume
  const bookingGrowth = safeValue(kpis?.bookingGrowthPct);
  if (bookingGrowth !== null && bookingGrowth >= 25) {
    out.push({
      id: "booking_elevated",
      surface: "footprint",
      tone: "positive",
      label: `Booking volume significantly elevated +${bookingGrowth}%`,
      detail: "Booking growth rate vs prior period.",
    });
  } else if (bookingGrowth !== null && bookingGrowth <= -25) {
    out.push({
      id: "booking_dropping",
      surface: "footprint",
      tone: "warning",
      label: `Booking volume dropping ${bookingGrowth}%`,
      detail: "Material booking-growth decline detected.",
    });
  }

  // 4. Trial conversion
  if (context.trialConversionPct !== null && context.trialConversionPct >= 25) {
    out.push({
      id: "trial_conversion_healthy",
      surface: "revenue",
      tone: "positive",
      label: `Free-tier conversion healthy ${context.trialConversionPct}%`,
      detail: "Trial → paid rate among 30d cohort.",
    });
  } else if (context.trialConversionPct !== null && context.trialConversionPct < 10 && context.trialingNow >= 5) {
    out.push({
      id: "trial_conversion_low",
      surface: "revenue",
      tone: "warning",
      label: `Trial conversion ${context.trialConversionPct}% — investigate friction`,
      detail: `${context.trialingNow} active trials. Low conversion may indicate onboarding gaps.`,
    });
  }

  // 5. Email delivery
  const totalEmail = context.emailSent7d + context.emailFailures7d;
  if (totalEmail >= 50) {
    const failPct = Math.round((context.emailFailures7d / totalEmail) * 1000) / 10;
    if (failPct < 2) {
      out.push({
        id: "delivery_stable",
        surface: "ops",
        tone: "positive",
        label: "Reminder delivery stable",
        detail: `${context.emailSent7d} sent / ${context.emailFailures7d} failed (7d) — ${failPct}% failure rate.`,
      });
    } else if (failPct >= 5) {
      out.push({
        id: "delivery_degraded",
        surface: "ops",
        tone: failPct >= 15 ? "critical" : "warning",
        label: `Reminder delivery degraded — ${failPct}% failure rate (7d)`,
        detail: "Check SES suppression list and sender identity verification.",
      });
    }
  }

  // 6. Operational systems
  if (mission.operationalStatus === "calm" && mission.activeIncidents === 0) {
    out.push({
      id: "ops_healthy",
      surface: "hero",
      tone: "positive",
      label: "Operational systems healthy",
      detail: "No active incidents. Email delivery, OAuth, and payments all clean.",
    });
  }

  // 7. Incident state
  if (mission.activeIncidents >= 2) {
    const reasons: string[] = [];
    if (context.pastDueNow > 0) reasons.push(`${context.pastDueNow} past-due`);
    if (context.expiredGoogleCount >= 3) reasons.push(`${context.expiredGoogleCount} OAuth broken`);
    out.push({
      id: "active_incidents",
      surface: "hero",
      tone: "critical",
      label: `${mission.activeIncidents} active incidents`,
      detail: reasons.join(" · "),
    });
  }

  // 8. Business health summary
  if (mission.businessHealthScore >= 85) {
    out.push({
      id: "business_health_strong",
      surface: "hero",
      tone: "positive",
      label: `Business health ${mission.businessHealthScore} — strong`,
      detail: "Revenue + growth + ops + stability composite above target.",
    });
  } else if (mission.businessHealthScore < 60) {
    out.push({
      id: "business_health_weak",
      surface: "hero",
      tone: "warning",
      label: `Business health ${mission.businessHealthScore} — review`,
      detail: "Weighted composite below confidence threshold.",
    });
  }

  return out;
}
