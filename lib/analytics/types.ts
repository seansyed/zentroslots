/**
 * Shared types for the analytics subsystem.
 *
 * `DailyAggregate` is the in-memory result the aggregation orchestrator
 * builds for one (tenant, day). The persistent shape is in db/schema
 * (analyticsDailySnapshots) — same fields plus extras jsonb.
 */

export type DailyAggregate = {
  tenantId: string;
  /** YYYY-MM-DD UTC. */
  snapshotDate: string;
  totalBookings: number;
  completedBookings: number;
  cancelledBookings: number;
  noShowBookings: number;
  recurringBookings: number;
  waitlistJoins: number;
  waitlistConversions: number;
  reviewRequestsSent: number;
  reviewsCompleted: number;
  reminderEmailsSent: number;
  reminderEmailsSuppressed: number;
  followupsSent: number;
  averageBookingLeadHours: number | null;
  extras: SnapshotExtras;
};

/** Side-channel metrics. Each subsystem may write its own key. */
export type SnapshotExtras = {
  /** Per-staff assignment counts for the day. */
  staffAssignments?: Record<string, number>;
  /** Per-service booking counts for the day. */
  servicePopularity?: Record<string, number>;
  /** Distribution of booking start hours (0..23). */
  hourDistribution?: number[];
  /** Distribution of booking start weekdays (Sun=0..Sat=6). */
  weekdayDistribution?: number[];
  /** Routing analytics. */
  routing?: {
    /** Total bookings created via the auto routing engine today. */
    autoAssignments: number;
    /** Total bookings created with direct (customer-picked) staff. */
    directAssignments: number;
  };
  /** Waitlist analytics. */
  waitlist?: {
    expiredHolds: number;
    avgWaitMinutes: number | null;
  };
  /** Communication delivery analytics. */
  comms?: {
    totalSent: number;
    totalFailed: number;
    totalSkipped: number;
  };
  /** Revenue analytics — populated when billing_transactions has rows
   *  for the tenant on this day. Absent for tenants without Stripe
   *  traffic (graceful degradation). */
  revenue?: {
    grossRevenueCents: number;
    refundedRevenueCents: number;
    netRevenueCents: number;
    successfulPayments: number;
    failedPayments: number;
    avgBookingValueCents: number;
  };
  serviceRevenue?: Array<{
    serviceId: string;
    serviceName: string;
    revenueCents: number;
    bookings: number;
  }>;
  staffRevenue?: Array<{
    staffId: string;
    staffName: string;
    revenueCents: number;
    bookings: number;
  }>;
};

/** Empty default — used when a tenant had no activity on a given day. */
export function emptyAggregate(tenantId: string, snapshotDate: string): DailyAggregate {
  return {
    tenantId,
    snapshotDate,
    totalBookings: 0,
    completedBookings: 0,
    cancelledBookings: 0,
    noShowBookings: 0,
    recurringBookings: 0,
    waitlistJoins: 0,
    waitlistConversions: 0,
    reviewRequestsSent: 0,
    reviewsCompleted: 0,
    reminderEmailsSent: 0,
    reminderEmailsSuppressed: 0,
    followupsSent: 0,
    averageBookingLeadHours: null,
    extras: {},
  };
}
