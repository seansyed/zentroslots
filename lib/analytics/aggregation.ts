/**
 * Build + upsert a daily analytics snapshot for one (tenant, day).
 *
 * Idempotent: re-running for the same (tenant, snapshotDate) UPDATES
 * the existing row. The aggregation worker can safely re-run any
 * historical date to backfill.
 *
 * Never throws. Caller (the cron worker) logs failures and moves to
 * the next (tenant, day). Rule #13 — analytics failures NEVER affect
 * the booking lifecycle (we don't touch bookings/users/etc here).
 */
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { analyticsDailySnapshots } from "@/db/schema";

import { aggregateAutomationMetrics } from "./automationMetrics";
import { aggregateBookingMetrics } from "./bookingMetrics";
import { aggregateRevenueMetrics } from "./revenueMetrics";
import { aggregateRoutingMetrics } from "./routingMetrics";
import { aggregateWaitlistMetrics } from "./waitlistMetrics";
import { computeForecast } from "./forecasting";
import { buildStaffingInsights } from "./staffingInsights";
import { buildRecommendations } from "./recommendations";
import { buildOptimizationRecommendations } from "./optimizationEngine";
import type { DailyAggregate, SnapshotExtras } from "./types";

export type AggregateInput = {
  tenantId: string;
  /** UTC midnight of the day to aggregate. */
  dayStart: Date;
};

export type AggregateResult =
  | { ok: true; snapshotId: string; aggregate: DailyAggregate }
  | { ok: false; reason: string };

const ONE_DAY_MS = 24 * 60 * 60_000;

export async function aggregateDailyAnalytics(input: AggregateInput): Promise<AggregateResult> {
  try {
    const dayEnd = new Date(input.dayStart.getTime() + ONE_DAY_MS);
    const snapshotDate = input.dayStart.toISOString().slice(0, 10);

    // Run all metric families in parallel — each is a single
    // tenant-scoped read. Revenue is additive; it returns an empty
    // shape when the tenant has no billing_transactions rows.
    const [bookingCounts, routing, waitlist, automation, revenue] = await Promise.all([
      aggregateBookingMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
      aggregateRoutingMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
      aggregateWaitlistMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
      aggregateAutomationMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
      aggregateRevenueMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
    ]);

    const extras: SnapshotExtras = {
      staffAssignments: routing.staffAssignments,
      servicePopularity: bookingCounts.servicePopularity,
      hourDistribution: bookingCounts.hourDistribution,
      weekdayDistribution: bookingCounts.weekdayDistribution,
      routing: {
        autoAssignments: routing.autoAssignments,
        directAssignments: routing.directAssignments,
      },
      waitlist: {
        expiredHolds: waitlist.expiredHolds,
        avgWaitMinutes: waitlist.avgWaitMinutes,
      },
      comms: {
        totalSent: automation.totalSent,
        totalFailed: automation.totalFailed,
        totalSkipped: automation.totalSkipped,
      },
      // Only attach revenue when there's actual data — keeps the
      // dashboard "no revenue yet" branch clean and prevents zero
      // rows from cluttering otherwise-quiet snapshots.
      ...(revenue.summary.grossRevenueCents > 0 ||
      revenue.summary.refundedRevenueCents > 0 ||
      revenue.summary.failedPayments > 0
        ? {
            revenue: revenue.summary,
            serviceRevenue: revenue.serviceRevenue,
            staffRevenue: revenue.staffRevenue,
          }
        : {}),
    };

    // ── Trailing-window intelligence (forecasting + staffing + recs)
    // Computed from the LAST 30 SNAPSHOTS (inclusive of today's just-
    // built aggregate). Pure functions, defensive — each wrapped so
    // a single failure doesn't block the snapshot write.
    try {
      const trailingStart = new Date(input.dayStart.getTime() - 29 * ONE_DAY_MS);
      const trailingStartStr = trailingStart.toISOString().slice(0, 10);
      const trailingRows = await db
        .select()
        .from(analyticsDailySnapshots)
        .where(
          and(
            eq(analyticsDailySnapshots.tenantId, input.tenantId),
            gte(analyticsDailySnapshots.snapshotDate, trailingStartStr),
            lt(analyticsDailySnapshots.snapshotDate, snapshotDate)
          )
        )
        .orderBy(asc(analyticsDailySnapshots.snapshotDate));

      const trailing: DailyAggregate[] = trailingRows.map((r) => ({
        tenantId: r.tenantId,
        snapshotDate: r.snapshotDate,
        totalBookings: r.totalBookings,
        completedBookings: r.completedBookings,
        cancelledBookings: r.cancelledBookings,
        noShowBookings: r.noShowBookings,
        recurringBookings: r.recurringBookings,
        waitlistJoins: r.waitlistJoins,
        waitlistConversions: r.waitlistConversions,
        reviewRequestsSent: r.reviewRequestsSent,
        reviewsCompleted: r.reviewsCompleted,
        reminderEmailsSent: r.reminderEmailsSent,
        reminderEmailsSuppressed: r.reminderEmailsSuppressed,
        followupsSent: r.followupsSent,
        averageBookingLeadHours: r.averageBookingLeadHours,
        extras: (r.extras as SnapshotExtras) ?? {},
      }));

      // Synthesize a placeholder for today so the window includes the
      // freshly-computed metrics. We build a minimal DailyAggregate
      // matching the in-flight values.
      const todayProvisional: DailyAggregate = {
        tenantId: input.tenantId,
        snapshotDate,
        totalBookings: bookingCounts.total,
        completedBookings: bookingCounts.completed,
        cancelledBookings: bookingCounts.cancelled,
        noShowBookings: bookingCounts.noShow,
        recurringBookings: bookingCounts.recurring,
        waitlistJoins: waitlist.joins,
        waitlistConversions: waitlist.conversions,
        reviewRequestsSent: automation.reviewRequestsSent,
        reviewsCompleted: 0,
        reminderEmailsSent: automation.reminderEmailsSent,
        reminderEmailsSuppressed: automation.reminderEmailsSuppressed,
        followupsSent: automation.followupsSent,
        averageBookingLeadHours: bookingCounts.averageBookingLeadHours,
        extras,
      };
      const window = [...trailing, todayProvisional];

      const forecast = computeForecast(window);
      const { insights, signals } = buildStaffingInsights(window);
      const recommendations = buildRecommendations({
        snapshots: window,
        forecast,
        staffingSignals: signals,
      });

      if (forecast) extras.forecasting = forecast;
      if (insights.length > 0 || signals.overloadStaff > 0 || signals.underutilizedStaff > 0) {
        extras.staffingInsights = {
          overloadStaff: signals.overloadStaff,
          underutilizedStaff: signals.underutilizedStaff,
          unevenAssignment: signals.unevenAssignment,
          bookingSurge: signals.bookingSurge,
          highCancelWeekdays: signals.highCancelWeekdays,
          messages: insights.map((i) => ({ code: i.code, severity: i.severity, message: i.message })),
        };
      }
      if (recommendations.length > 0) extras.recommendations = recommendations;

      // ── Optimization engine — richer recommendation shape (6 categories,
      // priority bands, projected impact). Composes the already-computed
      // forecast + staffing + legacy recs so we don't pay double-compute.
      // Wrapped separately so a bug here cannot suppress the simpler
      // legacy `recommendations` write above.
      try {
        const optStart = Date.now();
        const optimizationRecs = buildOptimizationRecommendations({
          snapshots: window,
          forecast,
          staffing: { insights, signals },
          legacyRecommendations: recommendations,
          // customerIntelligence is intentionally omitted here — it would
          // require a tenant-scoped DB read inside this pure block. The
          // scheduledReports composer adds it at report-build time.
        });
        extras.optimizationGenerationMs = Date.now() - optStart;
        if (optimizationRecs.length > 0) {
          extras.optimizationRecommendations = optimizationRecs;
        }
      } catch (e) {
        console.error("[analytics] optimization engine failed:", e);
      }
    } catch (e) {
      console.error("[analytics] trailing-window intelligence failed:", e);
      // Rule #13: never breaks the snapshot write. Day-level counts
      // are still captured below.
    }

    const aggregate: DailyAggregate = {
      tenantId: input.tenantId,
      snapshotDate,
      totalBookings: bookingCounts.total,
      completedBookings: bookingCounts.completed,
      cancelledBookings: bookingCounts.cancelled,
      noShowBookings: bookingCounts.noShow,
      recurringBookings: bookingCounts.recurring,
      waitlistJoins: waitlist.joins,
      waitlistConversions: waitlist.conversions,
      reviewRequestsSent: automation.reviewRequestsSent,
      reviewsCompleted: 0, // reserved — no review-completion event today
      reminderEmailsSent: automation.reminderEmailsSent,
      reminderEmailsSuppressed: automation.reminderEmailsSuppressed,
      followupsSent: automation.followupsSent,
      averageBookingLeadHours: bookingCounts.averageBookingLeadHours,
      extras,
    };

    // UPSERT by (tenant, snapshot_date). The partial unique index
    // backs the conflict resolution.
    const existing = await db.query.analyticsDailySnapshots.findFirst({
      where: and(
        eq(analyticsDailySnapshots.tenantId, input.tenantId),
        eq(analyticsDailySnapshots.snapshotDate, snapshotDate)
      ),
    });
    let snapshotId: string;
    if (existing) {
      await db
        .update(analyticsDailySnapshots)
        .set({
          totalBookings: aggregate.totalBookings,
          completedBookings: aggregate.completedBookings,
          cancelledBookings: aggregate.cancelledBookings,
          noShowBookings: aggregate.noShowBookings,
          recurringBookings: aggregate.recurringBookings,
          waitlistJoins: aggregate.waitlistJoins,
          waitlistConversions: aggregate.waitlistConversions,
          reviewRequestsSent: aggregate.reviewRequestsSent,
          reviewsCompleted: aggregate.reviewsCompleted,
          reminderEmailsSent: aggregate.reminderEmailsSent,
          reminderEmailsSuppressed: aggregate.reminderEmailsSuppressed,
          followupsSent: aggregate.followupsSent,
          averageBookingLeadHours: aggregate.averageBookingLeadHours,
          extras: aggregate.extras,
        })
        .where(eq(analyticsDailySnapshots.id, existing.id));
      snapshotId = existing.id;
    } else {
      const [row] = await db
        .insert(analyticsDailySnapshots)
        .values({
          tenantId: aggregate.tenantId,
          snapshotDate: aggregate.snapshotDate,
          totalBookings: aggregate.totalBookings,
          completedBookings: aggregate.completedBookings,
          cancelledBookings: aggregate.cancelledBookings,
          noShowBookings: aggregate.noShowBookings,
          recurringBookings: aggregate.recurringBookings,
          waitlistJoins: aggregate.waitlistJoins,
          waitlistConversions: aggregate.waitlistConversions,
          reviewRequestsSent: aggregate.reviewRequestsSent,
          reviewsCompleted: aggregate.reviewsCompleted,
          reminderEmailsSent: aggregate.reminderEmailsSent,
          reminderEmailsSuppressed: aggregate.reminderEmailsSuppressed,
          followupsSent: aggregate.followupsSent,
          averageBookingLeadHours: aggregate.averageBookingLeadHours,
          extras: aggregate.extras,
        })
        .returning({ id: analyticsDailySnapshots.id });
      snapshotId = row.id;
    }

    return { ok: true, snapshotId, aggregate };
  } catch (e) {
    console.error(`[analytics] aggregate failed for ${input.tenantId}@${input.dayStart.toISOString()}:`, e);
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
  }
}

void sql;
