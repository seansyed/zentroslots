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
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { analyticsDailySnapshots } from "@/db/schema";

import { aggregateAutomationMetrics } from "./automationMetrics";
import { aggregateBookingMetrics } from "./bookingMetrics";
import { aggregateRoutingMetrics } from "./routingMetrics";
import { aggregateWaitlistMetrics } from "./waitlistMetrics";
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

    // Run all four metric families in parallel — each is a single
    // tenant-scoped read.
    const [bookingCounts, routing, waitlist, automation] = await Promise.all([
      aggregateBookingMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
      aggregateRoutingMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
      aggregateWaitlistMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
      aggregateAutomationMetrics({ tenantId: input.tenantId, dayStart: input.dayStart, dayEnd }),
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
    };

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
