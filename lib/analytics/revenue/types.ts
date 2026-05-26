/**
 * Phase SMART-4 — typed contracts for the revenue intelligence
 * overlay.
 *
 * This module composes EXISTING analytics primitives:
 *   • lib/analytics/revenueMetrics.ts      gross/net/per-service breakdowns
 *   • lib/analytics/staffingInsights.ts    staff performance signals
 *   • lib/analytics/customerIntelligence.ts retention + repeat signals
 *   • lib/analytics/optimizationEngine.ts  recommendation generator
 *   • analytics_daily_snapshots table      pre-rolled daily aggregates
 *   • embedEvents table                    booking-page visit tracking
 *
 * It adds:
 *   • no-show LOSS estimation (existing metrics tracked counts, not
 *     monetary impact)
 *   • slot value scoring (demand × price → "premium" / "popular"
 *     signal)
 *   • conversion funnel aggregation (page visits ÷ completed
 *     bookings)
 *   • a single ROI composer endpoint that returns the unified view
 *
 * Determinism contract:
 *   • All scorers + composers are pure functions over their
 *     inputs. No Math.random, no Date.now (callers pass `now`).
 *   • No generative AI — every "reason" string is template-rendered
 *     from numeric thresholds.
 *
 * Currency:
 *   • All monetary fields are in CENTS as integers. This matches
 *     services.price + billing_transactions.amount_cents in the
 *     existing schema.
 *   • The composer never multiplies cents by a float — every
 *     calculation produces an integer.
 */

/** A money amount in the tenant's base currency. Always cents. */
export type Cents = number;

/** Loss estimate for one bucket of no-show bookings. */
export type NoShowLossBucket = {
  /** Number of no-show bookings in this bucket. */
  count: number;
  /** Estimated lost revenue from this bucket, in cents. */
  estimatedLossCents: Cents;
  /** Total wasted staff-minutes (sum of service durations). */
  wastedStaffMinutes: number;
};

/** Per-service no-show loss breakdown. */
export type NoShowLossPerService = {
  serviceId: string;
  serviceName: string;
  count: number;
  estimatedLossCents: Cents;
  wastedStaffMinutes: number;
  /** Service unit price at the time of the calculation. */
  pricePerBookingCents: Cents;
};

/** Result of the no-show loss calculator. Pure data — the route
 *  handler composes this into the full ROI payload. */
export type NoShowLossResult = {
  windowDays: number;
  total: NoShowLossBucket;
  perService: NoShowLossPerService[];
  /** Top contributing customer emails (lowered) — for follow-up
   *  outreach. Capped at 10. */
  topCustomers: {
    email: string;
    count: number;
    estimatedLossCents: Cents;
  }[];
};

/** Slot value signal — surfaced as a UI chip on the booking page
 *  in a future phase. The intelligence layer returns one of these
 *  per slot; UI is free to ignore. */
export type SlotValueSignal =
  | "premium"        // high price + high demand
  | "popular"        // high historical density
  | "fast_booking"   // same-day or short-lead
  | "high_demand"   // density rising sharply
  | null;            // no signal worth showing

/** Slot value scoring input. Pure data — no DB handles. */
export type SlotValueInput = {
  /** Slot start (UTC). */
  slotStart: Date;
  /** Service unit price in cents — drives the "premium" branch. */
  servicePriceCents: Cents;
  /** Service duration in minutes. */
  durationMinutes: number;
  /** Historical bookings count in this (staff, hour-of-day,
   *  day-of-week) bucket over the last 30 days. */
  historicalBookings: number;
  /** Staff's MEAN bookings-per-cell over the same window. Used to
   *  decide whether this cell is "above average" → popular. */
  staffMeanBookings: number;
  /** Lead time from now to slot start (hours). Drives the
   *  "fast_booking" branch. */
  leadHours: number;
  /** Workspace MEDIAN service price in cents. Used to decide
   *  whether this service is "premium" relative to the catalog. */
  workspaceMedianPriceCents: Cents;
  /** Override `now` for tests. */
  now?: Date;
};

/** Slot value scoring output. */
export type SlotValueAssessment = {
  /** Numeric 0..100 — higher = more valuable to fill. Used for
   *  sorting in admin views. */
  score: number;
  /** UI signal — null when nothing exceeds the surfacing threshold. */
  signal: SlotValueSignal;
  /** Deterministic reasoning lines (template-rendered, ≤ 2). */
  reasons: string[];
};

/** Booking page conversion funnel — visits → selections → bookings. */
export type ConversionFunnel = {
  windowDays: number;
  /** Total page visit events from embed_events. */
  pageVisits: number;
  /** Total confirmed/completed bookings created in the window. */
  completedBookings: number;
  /** Bookings that ended in cancellation. */
  cancelledBookings: number;
  /** Bookings that ended in no-show. */
  noShowBookings: number;
  /** Page visit → booking conversion rate as a 0..100 percentage. */
  visitToBookingRatePct: number;
  /** Net booking rate — confirmed-or-completed ÷ all bookings created. */
  bookingCompletionRatePct: number;
};

/** Composite ROI payload returned by the SMART-4 endpoint. */
export type RevenueIntelligencePayload = {
  tenantId: string;
  generatedAt: string;
  windowDays: number;
  currency: string;
  /** No-show financial impact. */
  noShowLoss: NoShowLossResult;
  /** Conversion funnel summary. */
  conversion: ConversionFunnel;
  /** Top-revenue staff in the window. Pulled from existing
   *  revenueMetrics aggregator. */
  topStaffByRevenue: {
    staffId: string;
    staffName: string;
    revenueCents: Cents;
    bookings: number;
    revenuePerBookingCents: Cents;
  }[];
  /** Top-revenue services in the window. */
  topServicesByRevenue: {
    serviceId: string;
    serviceName: string;
    revenueCents: Cents;
    bookings: number;
  }[];
  /** Headline numbers. */
  summary: {
    grossRevenueCents: Cents;
    netRevenueCents: Cents;
    estimatedLossFromNoShowsCents: Cents;
    successfulPayments: number;
    failedPayments: number;
    avgBookingValueCents: Cents;
  };
};
