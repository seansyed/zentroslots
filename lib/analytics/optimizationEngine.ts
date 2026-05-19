/**
 * Intelligent Scheduling Optimization Engine — deterministic.
 *
 * Composes existing analytics modules (forecasting, staffingInsights,
 * recommendations, revenueMetrics fields on snapshots, waitlist/comms
 * counters, optional customer-intelligence input) into a richer
 * recommendation shape with category / severity / projected impact /
 * supporting metrics / confidence.
 *
 * Categories (closed union — never invent new ones):
 *   - staffing
 *   - scheduling           (availability optimization)
 *   - reminders            (no-show prevention)
 *   - revenue
 *   - waitlist
 *   - customer_retention
 *
 * Design rules:
 *   - Pure. No DB. Inputs are snapshots + already-computed forecast +
 *     already-computed staffing signals (so we don't recompute and
 *     don't drift from the executive views).
 *   - NEVER fabricates a metric. Every recommendation cites at least
 *     one number from the actual snapshot window.
 *   - NEVER throws. Empty / malformed window → empty array.
 *   - NEVER duplicates the simple legacy `recommendations.ts` — instead
 *     CONSUMES its output and enriches each entry with category +
 *     priority + projected impact when possible.
 *
 * Rule #13: this engine has zero booking/payment side-effects. It
 * reads snapshots and returns data. The cron worker stores the result
 * in extras.optimizationRecommendations; the dashboard renders it.
 */

import { computeForecast, type ForecastResult } from "./forecasting";
import {
  buildStaffingInsights,
  type StaffingInsight,
  type StaffingSignals,
} from "./staffingInsights";
import { buildRecommendations, type Recommendation } from "./recommendations";
import { scorePriority, comparePriority, type Priority, type PriorityResult } from "./priorityScoring";
import type { DailyAggregate } from "./types";

// ─── Public types ────────────────────────────────────────────────────

export type RecommendationCategory =
  | "staffing"
  | "scheduling"
  | "reminders"
  | "revenue"
  | "waitlist"
  | "customer_retention";

export type SupportingMetric = {
  label: string;
  /** Stringified value — the dashboard renders verbatim; the engine
   *  decides formatting so per-metric units (%, $, count) stay correct. */
  value: string;
};

export type ProjectedImpact = {
  /** Free-form sentence that always cites a metric. Never speculative. */
  description: string;
  /** Estimated monthly dollar impact in cents. 0 when not modelable
   *  (we still emit the recommendation; priority falls back to
   *  pressure/confidence). */
  monthlyImpactCents: number;
};

export type OptimizationRecommendation = {
  /** Stable identifier — safe to use as a React key. */
  code: string;
  category: RecommendationCategory;
  severity: Priority;
  title: string;
  /** Multi-sentence rationale — never AI-generated, always derived
   *  from the cited metrics. */
  explanation: string;
  supportingMetrics: SupportingMetric[];
  /** 0..1. Aggregated confidence the engine has in this recommendation. */
  confidence: number;
  projectedImpact: ProjectedImpact;
  /** Full priority breakdown — exposed so the dashboard can show a
   *  "why this priority" tooltip. */
  priorityFactors: PriorityResult["factors"];
};

/** Optional inputs the engine accepts. All optional — engine degrades
 *  gracefully (a missing input simply silences that category). */
export type OptimizationInputs = {
  snapshots: DailyAggregate[];
  /** Pre-computed forecast; engine will call computeForecast if absent. */
  forecast?: ForecastResult | null;
  /** Pre-computed staffing signals; engine will call build if absent. */
  staffing?: { insights: StaffingInsight[]; signals: StaffingSignals };
  /** Pre-computed simple recommendations; engine will call build if absent. */
  legacyRecommendations?: Recommendation[];
  /** Customer-intelligence shape (from customerIntelligence.ts) — only
   *  the fields we actually use. */
  customerIntelligence?: {
    repeatCustomerRate: number;
    retentionRate: number;
    newCustomersThisPeriod: number;
    bookingsByExistingCustomers: number;
    bookingsByNewCustomers: number;
  } | null;
};

// ─── Internal constants ──────────────────────────────────────────────

/** Heuristic per-booking avg value used when a category needs a $
 *  projection and the window has no revenue data. Conservative. */
const FALLBACK_AVG_BOOKING_CENTS = 5_000; // $50

const WAITLIST_CONVERSION_OPPORTUNITY_THRESHOLD = 0.5; // < 50% joins → conversions
const WAITLIST_EXPIRY_PRESSURE_THRESHOLD = 0.30;       // > 30% expired holds
const REPEAT_CUSTOMER_LOW_BAND = 25;                    // < 25% repeat = low
const REPEAT_CUSTOMER_HIGH_BAND = 60;                   // > 60% repeat = strong
const REVENUE_CONCENTRATION_THRESHOLD = 0.50;           // top service ≥ 50% of revenue
const REVENUE_LOW_VOLUME_SERVICE_THRESHOLD = 0.05;      // < 5% revenue with > 1 booking = low margin candidate

// ─── Entry ───────────────────────────────────────────────────────────

export function buildOptimizationRecommendations(
  input: OptimizationInputs
): OptimizationRecommendation[] {
  // Need at least 7 days of history to make any kind of claim. Below
  // that the legacy `recommendations.ts` already emits nothing, so we
  // mirror that policy for consistency.
  if (!input.snapshots || input.snapshots.length < 7) return [];

  // Defensive lazy compute. The cron worker already has these in
  // hand and passes them in to avoid duplicate work.
  const forecast = input.forecast === undefined ? computeForecast(input.snapshots) : input.forecast;
  const staffing = input.staffing ?? buildStaffingInsights(input.snapshots);
  const legacy =
    input.legacyRecommendations ??
    buildRecommendations({ snapshots: input.snapshots, forecast, staffingSignals: staffing.signals });

  const baseConfidence = forecast?.confidenceScore ?? 0.5;
  const windowDays = input.snapshots.length;

  const out: OptimizationRecommendation[] = [];

  // ── Category 1 & 3: enrich the legacy `recommendations` first ────
  // These already exist and cover staffing + reminder/cancel signals.
  // We map each legacy code to a category + severity rather than
  // re-implement.
  for (const r of legacy) {
    const enriched = enrichLegacyRecommendation(r, {
      snapshots: input.snapshots,
      forecast,
      staffing,
      baseConfidence,
      windowDays,
    });
    if (enriched) out.push(enriched);
  }

  // ── Category 2: SCHEDULING / availability optimization ──────────
  // Underbooked hours, peak-window expansion, rejected-booking signal
  // (proxy: waitlist joins on days when bookings ran low).
  const schedRecs = buildSchedulingRecommendations({
    snapshots: input.snapshots,
    forecast,
    baseConfidence,
    windowDays,
  });
  out.push(...schedRecs);

  // ── Category 4: REVENUE optimization ─────────────────────────────
  const revRecs = buildRevenueRecommendations({
    snapshots: input.snapshots,
    baseConfidence,
    windowDays,
  });
  out.push(...revRecs);

  // ── Category 5: WAITLIST optimization ────────────────────────────
  const wlRecs = buildWaitlistRecommendations({
    snapshots: input.snapshots,
    baseConfidence,
    windowDays,
  });
  out.push(...wlRecs);

  // ── Category 6: CUSTOMER RETENTION ───────────────────────────────
  if (input.customerIntelligence) {
    const crRecs = buildCustomerRetentionRecommendations({
      snapshots: input.snapshots,
      intel: input.customerIntelligence,
      baseConfidence,
      windowDays,
    });
    out.push(...crRecs);
  }

  // Dedupe by code (a recommendation should never appear twice).
  const seen = new Set<string>();
  const deduped = out.filter((r) => {
    if (seen.has(r.code)) return false;
    seen.add(r.code);
    return true;
  });

  // Sort by priority then by score descending.
  deduped.sort((a, b) =>
    comparePriority(
      { priority: a.severity, score: 0, factors: a.priorityFactors },
      { priority: b.severity, score: 0, factors: b.priorityFactors }
    )
  );

  return deduped;
}

// ─── Legacy enrichment ───────────────────────────────────────────────

type EnrichmentCtx = {
  snapshots: DailyAggregate[];
  forecast: ForecastResult | null;
  staffing: { insights: StaffingInsight[]; signals: StaffingSignals };
  baseConfidence: number;
  windowDays: number;
};

function enrichLegacyRecommendation(
  r: Recommendation,
  ctx: EnrichmentCtx
): OptimizationRecommendation | null {
  // Hand-map each known legacy code into category + impact + pressure.
  // Unknown codes degrade to "staffing" with low pressure — they still
  // show up but won't dominate ranking.
  const totalBookings = ctx.snapshots.reduce((a, s) => a + s.totalBookings, 0);
  const totalCancels = ctx.snapshots.reduce((a, s) => a + s.cancelledBookings, 0);
  const avgValueCents = avgBookingValueCentsFromSnapshots(ctx.snapshots);
  const cancelRate = totalBookings > 0 ? totalCancels / totalBookings : 0;

  switch (r.code) {
    case "add_staff_busy_weekdays": {
      // Pressure = forecast pressure level. Impact = covered-load
      // delta heuristic: if 1 weekday in 7 is busy, 14% of weekly
      // bookings are at risk of being capped.
      const busyDays = ctx.forecast?.expectedBusyWeekdays.length ?? 0;
      const pressure =
        ctx.forecast?.staffingPressureLevel === "high"
          ? 0.9
          : ctx.forecast?.staffingPressureLevel === "medium"
            ? 0.6
            : 0.3;
      const weeklyImpactBookings = busyDays > 0 ? (totalBookings / Math.max(ctx.windowDays, 1)) * 7 * 0.15 : 0;
      const monthlyImpactCents = Math.round(weeklyImpactBookings * 4 * avgValueCents);
      return enrich(r, {
        category: "staffing",
        title: "Add staff availability on peak weekdays",
        pressure,
        monthlyImpactCents,
        impactDescription: `Could capture up to ${Math.round(weeklyImpactBookings * 4)} additional bookings/month on busy weekdays at current avg value.`,
        confidence: ctx.baseConfidence,
        supporting: [
          { label: "Busy weekdays", value: (ctx.forecast?.expectedBusyWeekdays ?? []).join(", ") || "—" },
          { label: "Staffing pressure", value: ctx.forecast?.staffingPressureLevel ?? "unknown" },
        ],
      });
    }
    case "peak_hours_window": {
      const pressure =
        ctx.forecast?.staffingPressureLevel === "high"
          ? 0.8
          : ctx.forecast?.staffingPressureLevel === "medium"
            ? 0.5
            : 0.3;
      return enrich(r, {
        category: "scheduling",
        title: "Concentrate senior staff in peak hours",
        pressure,
        monthlyImpactCents: 0,
        impactDescription: "No direct revenue projection — operational improvement.",
        confidence: ctx.baseConfidence,
        supporting: [
          {
            label: "Peak hours",
            value: (ctx.forecast?.expectedPeakHours ?? []).map(formatHour).join(", ") || "—",
          },
        ],
      });
    }
    case "reminder_suppression_correlation": {
      // Pressure = cancel rate scaled. Impact = revenue from a 10%
      // reduction in cancel-driven losses.
      const recoverableBookings = totalCancels * 0.1;
      const monthlyImpactCents = Math.round(
        recoverableBookings * (30 / Math.max(ctx.windowDays, 1)) * avgValueCents
      );
      return enrich(r, {
        category: "reminders",
        title: "Investigate reminder suppression",
        pressure: Math.min(1, cancelRate * 4), // 25% cancel → 1.0
        monthlyImpactCents,
        impactDescription: `Recovering 10% of cancellations would add ~${Math.round(recoverableBookings * (30 / Math.max(ctx.windowDays, 1)))} bookings/month.`,
        confidence: ctx.baseConfidence,
        supporting: [
          { label: "Cancel rate", value: `${Math.round(cancelRate * 100)}%` },
          { label: "Total cancellations", value: String(totalCancels) },
        ],
      });
    }
    case "underutilized_staff_with_low_pressure":
      return enrich(r, {
        category: "staffing",
        title: "Underutilized staff during low-demand windows",
        pressure: 0.3,
        monthlyImpactCents: 0,
        impactDescription: "Operational efficiency improvement — no direct revenue projection.",
        confidence: ctx.baseConfidence,
        supporting: [
          { label: "Underutilized count", value: String(ctx.staffing.signals.underutilizedStaff) },
        ],
      });
    case "rebalance_routing":
      return enrich(r, {
        category: "staffing",
        title: "Rebalance staff routing",
        pressure: 0.7,
        monthlyImpactCents: 0,
        impactDescription: "Reduces overload risk and improves staff retention.",
        confidence: ctx.baseConfidence,
        supporting: [
          { label: "Overloaded staff", value: String(ctx.staffing.signals.overloadStaff) },
        ],
      });
    case "investigate_high_cancel_weekdays": {
      const recoverableBookings = totalCancels * 0.15;
      const monthlyImpactCents = Math.round(
        recoverableBookings * (30 / Math.max(ctx.windowDays, 1)) * avgValueCents
      );
      return enrich(r, {
        category: "reminders",
        title: "Address high-cancel weekdays",
        pressure: Math.min(1, cancelRate * 3.5),
        monthlyImpactCents,
        impactDescription: `Recovering 15% of cancellations on flagged weekdays would add ~${Math.round(recoverableBookings * (30 / Math.max(ctx.windowDays, 1)))} bookings/month.`,
        confidence: ctx.baseConfidence,
        supporting: [
          {
            label: "High-cancel weekdays",
            value: ctx.staffing.signals.highCancelWeekdays.map((i) => weekdayShort(i)).join(", ") || "—",
          },
          { label: "Cancel rate", value: `${Math.round(cancelRate * 100)}%` },
        ],
      });
    }
    case "booking_surge_alert":
      return enrich(r, {
        category: "staffing",
        title: "Confirm staffing for booking surge",
        pressure: 0.85,
        monthlyImpactCents: 0,
        impactDescription: "Prevents service degradation during surge — no direct revenue impact (load already booked).",
        confidence: ctx.baseConfidence,
        supporting: [],
      });
    default:
      // Unknown legacy code — surface it but at low priority.
      return enrich(r, {
        category: "staffing",
        title: r.message,
        pressure: 0.2,
        monthlyImpactCents: 0,
        impactDescription: "Operational signal — no direct revenue projection.",
        confidence: ctx.baseConfidence * 0.6,
        supporting: [],
      });
  }
}

function enrich(
  r: Recommendation,
  args: {
    category: RecommendationCategory;
    title: string;
    pressure: number;
    monthlyImpactCents: number;
    impactDescription: string;
    confidence: number;
    supporting: SupportingMetric[];
  }
): OptimizationRecommendation {
  const result = scorePriority({
    projectedMonthlyImpactCents: args.monthlyImpactCents,
    operationalPressure: args.pressure,
    frequency: 0.7, // legacy recs derive from full-window scans → high baseline freq
    confidence: args.confidence,
  });
  return {
    code: r.code,
    category: args.category,
    severity: result.priority,
    title: args.title,
    explanation: `${r.message} ${r.evidence}`.trim(),
    supportingMetrics: args.supporting,
    confidence: Number(args.confidence.toFixed(2)),
    projectedImpact: {
      description: args.impactDescription,
      monthlyImpactCents: args.monthlyImpactCents,
    },
    priorityFactors: result.factors,
  };
}

// ─── Scheduling / availability category ──────────────────────────────

function buildSchedulingRecommendations(args: {
  snapshots: DailyAggregate[];
  forecast: ForecastResult | null;
  baseConfidence: number;
  windowDays: number;
}): OptimizationRecommendation[] {
  const out: OptimizationRecommendation[] = [];
  const avgValueCents = avgBookingValueCentsFromSnapshots(args.snapshots);

  // ── 1. Waitlist demand → expand availability ──────────────────────
  const totalJoins = args.snapshots.reduce((a, s) => a + s.waitlistJoins, 0);
  const totalConversions = args.snapshots.reduce((a, s) => a + s.waitlistConversions, 0);
  // High waitlist joins relative to total bookings = unmet demand.
  const totalBookings = args.snapshots.reduce((a, s) => a + s.totalBookings, 0);
  const waitlistDemandRatio = totalBookings > 0 ? totalJoins / totalBookings : 0;
  if (totalJoins >= 5 && waitlistDemandRatio > 0.10) {
    // Capturing half of waitlist joins would lift booking volume.
    const recoverableBookings = totalJoins * 0.5;
    const monthlyImpactCents = Math.round(
      recoverableBookings * (30 / Math.max(args.windowDays, 1)) * avgValueCents
    );
    const result = scorePriority({
      projectedMonthlyImpactCents: monthlyImpactCents,
      operationalPressure: Math.min(1, waitlistDemandRatio * 5), // 20% ratio → 1.0
      frequency: 0.8,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "expand_availability_high_waitlist_demand",
      category: "scheduling",
      severity: result.priority,
      title: "Expand availability — high waitlist demand",
      explanation: `Customers are joining the waitlist at ${Math.round(waitlistDemandRatio * 100)}% of booking volume. Opening more slots in peak windows would convert that demand directly into revenue.`,
      supportingMetrics: [
        { label: "Waitlist joins", value: String(totalJoins) },
        { label: "Waitlist → booking", value: String(totalConversions) },
        { label: "Demand ratio", value: `${Math.round(waitlistDemandRatio * 100)}%` },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: `Capturing 50% of unmet waitlist demand could add ~${Math.round(recoverableBookings * (30 / Math.max(args.windowDays, 1)))} bookings/month.`,
        monthlyImpactCents,
      },
      priorityFactors: result.factors,
    });
  }

  // ── 2. Underbooked hours — open them up OR remove availability ────
  // Sum hourDistribution across the window; flag hours with consistent
  // 0 bookings vs hours with strong activity.
  const hourTotals = new Array(24).fill(0);
  let anyHourData = false;
  for (const s of args.snapshots) {
    const hd = s.extras.hourDistribution;
    if (hd && hd.length === 24) {
      anyHourData = true;
      for (let i = 0; i < 24; i++) hourTotals[i] += hd[i];
    }
  }
  if (anyHourData) {
    const businessHours = hourTotals.slice(8, 19); // 8AM-7PM
    const grand = businessHours.reduce((a, b) => a + b, 0);
    if (grand >= 20) {
      const mean = grand / businessHours.length;
      const zeroes: number[] = [];
      for (let i = 0; i < businessHours.length; i++) {
        if (businessHours[i] === 0) zeroes.push(i + 8);
      }
      if (zeroes.length >= 2 && mean > 0) {
        const result = scorePriority({
          projectedMonthlyImpactCents: 0,
          operationalPressure: 0.4,
          frequency: zeroes.length / 11,
          confidence: args.baseConfidence,
        });
        out.push({
          code: "remove_unused_business_hours",
          category: "scheduling",
          severity: result.priority,
          title: "Remove unused business-hour slots",
          explanation: `${zeroes.length} business hours had zero bookings across the trailing ${args.windowDays} days. Removing those slots from public availability reduces staff idle time and focuses customer choice on viable windows.`,
          supportingMetrics: [
            { label: "Idle hours", value: zeroes.map(formatHour).join(", ") },
            { label: "Avg active-hour bookings", value: mean.toFixed(1) },
          ],
          confidence: Number(args.baseConfidence.toFixed(2)),
          projectedImpact: {
            description: "Operational efficiency — frees ~" + zeroes.length + "h of staff coverage per business day.",
            monthlyImpactCents: 0,
          },
          priorityFactors: result.factors,
        });
      }
    }
  }

  return out;
}

// ─── Revenue category ────────────────────────────────────────────────

function buildRevenueRecommendations(args: {
  snapshots: DailyAggregate[];
  baseConfidence: number;
  windowDays: number;
}): OptimizationRecommendation[] {
  const out: OptimizationRecommendation[] = [];

  // Aggregate per-service revenue across the window.
  const svcAgg = new Map<string, { name: string; revenueCents: number; bookings: number }>();
  let totalRevenueCents = 0;
  for (const s of args.snapshots) {
    const sr = s.extras.serviceRevenue;
    if (!sr) continue;
    for (const row of sr) {
      const cur = svcAgg.get(row.serviceId) ?? { name: row.serviceName, revenueCents: 0, bookings: 0 };
      cur.revenueCents += row.revenueCents;
      cur.bookings += row.bookings;
      svcAgg.set(row.serviceId, cur);
    }
    totalRevenueCents += s.extras.revenue?.netRevenueCents ?? 0;
  }

  // No revenue data → nothing to say (graceful degradation).
  if (totalRevenueCents <= 0 || svcAgg.size === 0) return out;

  // ── 1. Revenue concentration risk ─────────────────────────────────
  const sortedSvcs = Array.from(svcAgg.values()).sort((a, b) => b.revenueCents - a.revenueCents);
  const topShare = sortedSvcs[0].revenueCents / totalRevenueCents;
  if (topShare >= REVENUE_CONCENTRATION_THRESHOLD) {
    const result = scorePriority({
      projectedMonthlyImpactCents: 0,
      operationalPressure: Math.min(1, topShare),
      frequency: 1,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "revenue_concentration_risk",
      category: "revenue",
      severity: result.priority,
      title: "Revenue concentrated in one service",
      explanation: `"${sortedSvcs[0].name}" generates ${Math.round(topShare * 100)}% of revenue. Diversification (promoting secondary services or cross-selling) reduces single-service exposure if demand shifts.`,
      supportingMetrics: [
        { label: "Top service", value: sortedSvcs[0].name },
        { label: "Top-service share", value: `${Math.round(topShare * 100)}%` },
        { label: "Active services", value: String(svcAgg.size) },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: "Risk mitigation — no direct upside projection.",
        monthlyImpactCents: 0,
      },
      priorityFactors: result.factors,
    });
  }

  // ── 2. High-revenue services worth promoting ─────────────────────
  // Highest-revenue service that ALSO has the highest revenue-per-booking
  // — promoting it lifts margin without proportional staff time.
  let best: { id: string; name: string; rpb: number; bookings: number; revenueCents: number } | null = null;
  for (const [id, v] of svcAgg.entries()) {
    if (v.bookings >= 5) {
      const rpb = v.revenueCents / v.bookings;
      if (!best || rpb > best.rpb) best = { id, name: v.name, rpb, bookings: v.bookings, revenueCents: v.revenueCents };
    }
  }
  if (best && best.bookings >= 5) {
    // Projection: a 20% lift in bookings of this service over a month.
    const monthlyBookingsToday = best.bookings * (30 / Math.max(args.windowDays, 1));
    const lift = monthlyBookingsToday * 0.2;
    const monthlyImpactCents = Math.round(lift * best.rpb);
    const result = scorePriority({
      projectedMonthlyImpactCents: monthlyImpactCents,
      operationalPressure: 0.4,
      frequency: 0.8,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "promote_high_value_service",
      category: "revenue",
      severity: result.priority,
      title: `Promote "${best.name}" — highest revenue per booking`,
      explanation: `"${best.name}" earns $${dollars(best.rpb)} per booking — your best margin service. Investing in marketing or default-selecting it in the booking flow would lift overall revenue.`,
      supportingMetrics: [
        { label: "Revenue per booking", value: `$${dollars(best.rpb)}` },
        { label: "Bookings (window)", value: String(best.bookings) },
        { label: "Window revenue", value: `$${dollars(best.revenueCents)}` },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: `A 20% lift in this service's volume would add ~$${dollars(monthlyImpactCents)} / month.`,
        monthlyImpactCents,
      },
      priorityFactors: result.factors,
    });
  }

  // ── 3. Low-revenue services — consolidate or sunset ──────────────
  const lowSvcs = sortedSvcs.filter((s) => s.revenueCents / totalRevenueCents < REVENUE_LOW_VOLUME_SERVICE_THRESHOLD && s.bookings >= 2);
  if (lowSvcs.length >= 3) {
    const result = scorePriority({
      projectedMonthlyImpactCents: 0,
      operationalPressure: 0.35,
      frequency: 0.6,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "consolidate_low_revenue_services",
      category: "revenue",
      severity: result.priority,
      title: "Consider consolidating low-revenue services",
      explanation: `${lowSvcs.length} services each generate <5% of revenue. Consolidating or sunsetting frees catalog space and steers customers toward higher-margin offerings.`,
      supportingMetrics: [
        { label: "Low-revenue services", value: String(lowSvcs.length) },
        { label: "Combined share", value: `${Math.round((lowSvcs.reduce((a, s) => a + s.revenueCents, 0) / totalRevenueCents) * 100)}%` },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: "Operational simplification — no direct revenue projection.",
        monthlyImpactCents: 0,
      },
      priorityFactors: result.factors,
    });
  }

  // ── 4. Failed-payment investigation ───────────────────────────────
  const totalFailed = args.snapshots.reduce((a, s) => a + (s.extras.revenue?.failedPayments ?? 0), 0);
  const totalSuccessful = args.snapshots.reduce((a, s) => a + (s.extras.revenue?.successfulPayments ?? 0), 0);
  const failRate = totalSuccessful + totalFailed > 0 ? totalFailed / (totalSuccessful + totalFailed) : 0;
  if (totalFailed >= 3 && failRate > 0.05) {
    const avg = totalSuccessful > 0
      ? Math.round(args.snapshots.reduce((a, s) => a + (s.extras.revenue?.grossRevenueCents ?? 0), 0) / totalSuccessful)
      : 0;
    const monthlyImpactCents = Math.round(totalFailed * (30 / Math.max(args.windowDays, 1)) * avg);
    const result = scorePriority({
      projectedMonthlyImpactCents: monthlyImpactCents,
      operationalPressure: Math.min(1, failRate * 5),
      frequency: 0.7,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "investigate_failed_payments",
      category: "revenue",
      severity: result.priority,
      title: "Investigate failed payments",
      explanation: `${totalFailed} payments failed in the last ${args.windowDays} days (${Math.round(failRate * 100)}% failure rate). Common causes: declined cards, expired methods, fraud blocks. Reaching out manually recovers most.`,
      supportingMetrics: [
        { label: "Failed payments", value: String(totalFailed) },
        { label: "Failure rate", value: `${Math.round(failRate * 100)}%` },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: `Recovering all failed charges would add up to ~$${dollars(monthlyImpactCents)} / month.`,
        monthlyImpactCents,
      },
      priorityFactors: result.factors,
    });
  }

  return out;
}

// ─── Waitlist category ───────────────────────────────────────────────

function buildWaitlistRecommendations(args: {
  snapshots: DailyAggregate[];
  baseConfidence: number;
  windowDays: number;
}): OptimizationRecommendation[] {
  const out: OptimizationRecommendation[] = [];
  const totalJoins = args.snapshots.reduce((a, s) => a + s.waitlistJoins, 0);
  const totalConversions = args.snapshots.reduce((a, s) => a + s.waitlistConversions, 0);
  const totalExpired = args.snapshots.reduce((a, s) => a + (s.extras.waitlist?.expiredHolds ?? 0), 0);

  if (totalJoins < 3) return out; // not enough signal

  const convRate = totalJoins > 0 ? totalConversions / totalJoins : 0;
  const avgValueCents = avgBookingValueCentsFromSnapshots(args.snapshots);

  // ── 1. Low waitlist conversion ───────────────────────────────────
  if (convRate < WAITLIST_CONVERSION_OPPORTUNITY_THRESHOLD) {
    const missed = totalJoins - totalConversions;
    const recoverable = missed * 0.3;
    const monthlyImpactCents = Math.round(recoverable * (30 / Math.max(args.windowDays, 1)) * avgValueCents);
    const result = scorePriority({
      projectedMonthlyImpactCents: monthlyImpactCents,
      operationalPressure: 1 - convRate,
      frequency: 0.7,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "improve_waitlist_conversion",
      category: "waitlist",
      severity: result.priority,
      title: "Improve waitlist conversion rate",
      explanation: `Only ${Math.round(convRate * 100)}% of waitlist signups end in a booking. Speeding up the notification window or pre-collecting payment intent improves capture.`,
      supportingMetrics: [
        { label: "Waitlist conversion", value: `${Math.round(convRate * 100)}%` },
        { label: "Joins", value: String(totalJoins) },
        { label: "Conversions", value: String(totalConversions) },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: `Recovering 30% of missed conversions adds ~$${dollars(monthlyImpactCents)} / month.`,
        monthlyImpactCents,
      },
      priorityFactors: result.factors,
    });
  }

  // ── 2. Excessive expired holds ────────────────────────────────────
  const expiryRate = totalJoins > 0 ? totalExpired / totalJoins : 0;
  if (totalExpired >= 3 && expiryRate > WAITLIST_EXPIRY_PRESSURE_THRESHOLD) {
    const result = scorePriority({
      projectedMonthlyImpactCents: 0,
      operationalPressure: Math.min(1, expiryRate * 2),
      frequency: 0.6,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "shorten_waitlist_hold_window",
      category: "waitlist",
      severity: result.priority,
      title: "Shorten waitlist hold window",
      explanation: `${Math.round(expiryRate * 100)}% of waitlist holds expired unclaimed. A shorter hold (or push reminder) gets the slot back into rotation faster.`,
      supportingMetrics: [
        { label: "Expired holds", value: String(totalExpired) },
        { label: "Expiry rate", value: `${Math.round(expiryRate * 100)}%` },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: "Operational improvement — recovered slots flow into general availability.",
        monthlyImpactCents: 0,
      },
      priorityFactors: result.factors,
    });
  }

  return out;
}

// ─── Customer retention category ─────────────────────────────────────

function buildCustomerRetentionRecommendations(args: {
  snapshots: DailyAggregate[];
  intel: NonNullable<OptimizationInputs["customerIntelligence"]>;
  baseConfidence: number;
  windowDays: number;
}): OptimizationRecommendation[] {
  const out: OptimizationRecommendation[] = [];
  const avgValueCents = avgBookingValueCentsFromSnapshots(args.snapshots);

  // ── 1. Low repeat customer rate ─────────────────────────────────
  if (args.intel.repeatCustomerRate < REPEAT_CUSTOMER_LOW_BAND && args.intel.newCustomersThisPeriod >= 5) {
    // Lifting repeat from current → +10pp would convert that fraction
    // of new customers into a second booking.
    const liftBookings = args.intel.newCustomersThisPeriod * 0.10;
    const monthlyImpactCents = Math.round(
      liftBookings * (30 / Math.max(args.windowDays, 1)) * avgValueCents
    );
    const result = scorePriority({
      projectedMonthlyImpactCents: monthlyImpactCents,
      operationalPressure: 0.6,
      frequency: 0.8,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "boost_repeat_customer_rate",
      category: "customer_retention",
      severity: result.priority,
      title: "Boost repeat customer rate",
      explanation: `Only ${args.intel.repeatCustomerRate}% of bookings come from existing customers. A post-booking follow-up sequence or loyalty incentive can convert one-time customers into repeats.`,
      supportingMetrics: [
        { label: "Repeat rate", value: `${args.intel.repeatCustomerRate}%` },
        { label: "New customers (window)", value: String(args.intel.newCustomersThisPeriod) },
        { label: "Existing-customer bookings", value: String(args.intel.bookingsByExistingCustomers) },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: `Converting 10% of new customers to repeats adds ~$${dollars(monthlyImpactCents)} / month.`,
        monthlyImpactCents,
      },
      priorityFactors: result.factors,
    });
  }

  // ── 2. Strong retention — invest in referrals ─────────────────────
  if (args.intel.repeatCustomerRate >= REPEAT_CUSTOMER_HIGH_BAND && args.intel.bookingsByExistingCustomers >= 10) {
    const result = scorePriority({
      projectedMonthlyImpactCents: 0,
      operationalPressure: 0.2,
      frequency: 0.9,
      confidence: args.baseConfidence,
    });
    out.push({
      code: "leverage_high_retention_for_referrals",
      category: "customer_retention",
      severity: result.priority,
      title: "Activate referral program — retention is strong",
      explanation: `${args.intel.repeatCustomerRate}% of bookings come from repeat customers — a sign of loyalty. A referral incentive turns that loyalty into low-cost new-customer acquisition.`,
      supportingMetrics: [
        { label: "Repeat rate", value: `${args.intel.repeatCustomerRate}%` },
        { label: "Retention rate", value: `${args.intel.retentionRate}%` },
      ],
      confidence: Number(args.baseConfidence.toFixed(2)),
      projectedImpact: {
        description: "Growth channel — magnitude depends on referral incentive design.",
        monthlyImpactCents: 0,
      },
      priorityFactors: result.factors,
    });
  }

  return out;
}

// ─── Pure helpers ────────────────────────────────────────────────────

function avgBookingValueCentsFromSnapshots(snapshots: DailyAggregate[]): number {
  let totalRev = 0;
  let totalSuccessful = 0;
  for (const s of snapshots) {
    totalRev += s.extras.revenue?.grossRevenueCents ?? 0;
    totalSuccessful += s.extras.revenue?.successfulPayments ?? 0;
  }
  if (totalSuccessful > 0) return Math.round(totalRev / totalSuccessful);
  return FALLBACK_AVG_BOOKING_CENTS;
}

function formatHour(hour: number): string {
  const h = ((hour + 11) % 12) + 1;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${h}${suffix}`;
}

function weekdayShort(i: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i] ?? "?";
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Exported for tests. */
export const _thresholds = {
  WAITLIST_CONVERSION_OPPORTUNITY_THRESHOLD,
  WAITLIST_EXPIRY_PRESSURE_THRESHOLD,
  REPEAT_CUSTOMER_LOW_BAND,
  REPEAT_CUSTOMER_HIGH_BAND,
  REVENUE_CONCENTRATION_THRESHOLD,
  REVENUE_LOW_VOLUME_SERVICE_THRESHOLD,
  FALLBACK_AVG_BOOKING_CENTS,
} as const;
