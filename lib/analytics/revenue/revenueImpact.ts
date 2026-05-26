/**
 * Phase SMART-4 — revenue intelligence composer.
 *
 * Combines:
 *   • Phase 67's revenueMetrics aggregateRevenueMetrics()   for gross/net
 *   • SMART-4 computeNoShowLoss()                           for loss impact
 *   • SMART-4 computeConversionFunnel()                     for funnel
 *
 * Returns the unified RevenueIntelligencePayload. Strictly tenant-
 * scoped via each underlying aggregator. No mutation.
 */

import { aggregateRevenueMetrics } from "@/lib/analytics/revenueMetrics";
import { computeNoShowLoss } from "./noShowLoss";
import { computeConversionFunnel } from "./conversionMetrics";
import type {
  Cents,
  RevenueIntelligencePayload,
} from "./types";

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_CURRENCY = "usd";

export async function computeRevenueIntelligence(args: {
  tenantId: string;
  windowDays?: number;
}): Promise<RevenueIntelligencePayload> {
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowDays * 86_400_000);

  // Parallel aggregation — three independent reads. Each handles
  // its own failure modes; if any throws we surface it (admin
  // endpoint will errorResponse).
  const [revenue, noShow, conversion] = await Promise.all([
    aggregateRevenueMetrics({
      tenantId: args.tenantId,
      dayStart: windowStart,
      dayEnd: now,
    }),
    computeNoShowLoss({
      tenantId: args.tenantId,
      windowDays,
    }),
    computeConversionFunnel({
      tenantId: args.tenantId,
      windowDays,
    }),
  ]);

  // Top staff + services come from the existing aggregator. We
  // augment each row with revenuePerBookingCents (a derived field
  // the existing module doesn't compute) since it's the headline
  // staff-performance number.
  const topStaffByRevenue = revenue.staffRevenue
    .slice(0, 10)
    .map((s) => ({
      staffId: s.staffId,
      staffName: s.staffName,
      revenueCents: s.revenueCents as Cents,
      bookings: s.bookings,
      revenuePerBookingCents:
        s.bookings === 0 ? 0 : Math.round(s.revenueCents / s.bookings),
    }));

  const topServicesByRevenue = revenue.serviceRevenue
    .slice(0, 10)
    .map((s) => ({
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      revenueCents: s.revenueCents as Cents,
      bookings: s.bookings,
    }));

  return {
    tenantId: args.tenantId,
    generatedAt: now.toISOString(),
    windowDays,
    currency: DEFAULT_CURRENCY,
    noShowLoss: noShow,
    conversion,
    topStaffByRevenue,
    topServicesByRevenue,
    summary: {
      grossRevenueCents: revenue.summary.grossRevenueCents as Cents,
      netRevenueCents: revenue.summary.netRevenueCents as Cents,
      estimatedLossFromNoShowsCents: noShow.total.estimatedLossCents,
      successfulPayments: revenue.summary.successfulPayments,
      failedPayments: revenue.summary.failedPayments,
      avgBookingValueCents: revenue.summary.avgBookingValueCents as Cents,
    },
  };
}
