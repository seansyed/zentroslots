/**
 * Scheduled-report COMPOSER — pure function building the report body
 * from a snapshot window. The cron worker calls this and UPSERTs the
 * result; this file does NOT touch the DB.
 *
 * Body shape is intentionally a closed type so the API surface is
 * stable and the dashboard can render past reports without runtime
 * surprises.
 */
import { buildExecutiveSummary, type ExecutiveSummary } from "./executiveMetrics";
import type { DailyAggregate, SnapshotExtras } from "./types";

export type ReportPeriodType = "daily" | "weekly" | "monthly";

export type ScheduledReportBody = {
  periodType: ReportPeriodType;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  daysCovered: number;
  /** Sum totals across the period — easy "what shipped" recap. */
  totals: {
    bookings: number;
    completed: number;
    cancelled: number;
    waitlistConversions: number;
    remindersSent: number;
    followupsSent: number;
    grossRevenueCents: number;
    netRevenueCents: number;
    refundedRevenueCents: number;
    failedPayments: number;
  };
  /** Pulled from the LAST snapshot's extras when present. */
  forecasting: SnapshotExtras["forecasting"] | null;
  staffingInsights: SnapshotExtras["staffingInsights"] | null;
  recommendations: SnapshotExtras["recommendations"] | null;
  /** Executive comparison (this-period vs prior-period). Null when
   *  insufficient history. */
  executive: ExecutiveSummary | null;
};

export function composeScheduledReportBody(args: {
  periodType: ReportPeriodType;
  periodStart: string;
  periodEnd: string;
  /** Window covering BOTH this period and the immediately-prior period
   *  (for executive comparisons). Chronological order. */
  windowWithPriorPeriod: DailyAggregate[];
  /** Just the current period's snapshots for totals. */
  currentPeriodSnapshots: DailyAggregate[];
  /** Optional repeat-customer data fed in by the cron worker. */
  repeatCustomerData?: Parameters<typeof buildExecutiveSummary>[1];
}): ScheduledReportBody {
  // Sum totals over the current period only.
  const totals = args.currentPeriodSnapshots.reduce(
    (acc, s) => ({
      bookings: acc.bookings + s.totalBookings,
      completed: acc.completed + s.completedBookings,
      cancelled: acc.cancelled + s.cancelledBookings,
      waitlistConversions: acc.waitlistConversions + s.waitlistConversions,
      remindersSent: acc.remindersSent + s.reminderEmailsSent,
      followupsSent: acc.followupsSent + s.followupsSent,
      grossRevenueCents: acc.grossRevenueCents + (s.extras.revenue?.grossRevenueCents ?? 0),
      netRevenueCents: acc.netRevenueCents + (s.extras.revenue?.netRevenueCents ?? 0),
      refundedRevenueCents: acc.refundedRevenueCents + (s.extras.revenue?.refundedRevenueCents ?? 0),
      failedPayments: acc.failedPayments + (s.extras.revenue?.failedPayments ?? 0),
    }),
    {
      bookings: 0,
      completed: 0,
      cancelled: 0,
      waitlistConversions: 0,
      remindersSent: 0,
      followupsSent: 0,
      grossRevenueCents: 0,
      netRevenueCents: 0,
      refundedRevenueCents: 0,
      failedPayments: 0,
    }
  );

  // Latest snapshot in the window carries the trailing-window
  // intelligence (forecasting / staffingInsights / recommendations).
  const latest =
    args.currentPeriodSnapshots.length > 0
      ? args.currentPeriodSnapshots[args.currentPeriodSnapshots.length - 1]
      : null;

  const executive = buildExecutiveSummary(args.windowWithPriorPeriod, args.repeatCustomerData);

  return {
    periodType: args.periodType,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    daysCovered: args.currentPeriodSnapshots.length,
    totals,
    forecasting: latest?.extras.forecasting ?? null,
    staffingInsights: latest?.extras.staffingInsights ?? null,
    recommendations: latest?.extras.recommendations ?? null,
    executive,
  };
}

/** Period bounds helper. Returns the start/end date (UTC) for a given
 *  cadence ending today. */
export function periodBoundsFor(
  periodType: ReportPeriodType,
  endDate: Date
): { start: Date; end: Date; days: number } {
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
  if (periodType === "daily") {
    return { start: end, end, days: 1 };
  }
  if (periodType === "weekly") {
    const start = new Date(end.getTime() - 6 * 24 * 60 * 60_000);
    return { start, end, days: 7 };
  }
  // monthly — last 30 calendar days (simple, deterministic).
  const start = new Date(end.getTime() - 29 * 24 * 60 * 60_000);
  return { start, end, days: 30 };
}
