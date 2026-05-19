#!/usr/bin/env tsx
/**
 * generate-scheduled-reports.ts
 *
 * Builds + UPSERTs scheduled_reports rows for every tenant.
 *
 * Cadence (deterministic, based on UTC day):
 *   - daily:    every run, period = yesterday
 *   - weekly:   when today is Monday UTC, period = prior 7 days
 *   - monthly:  when today is day 1 UTC, period = prior 30 days
 *
 * Pass PERIOD_TYPES env (comma-separated) to force a subset for
 * backfill: PERIOD_TYPES=weekly,monthly npm run scheduled-reports:generate
 *
 *   Linux cron:  20 1 * * *  (cd /app && npm run scheduled-reports:generate)
 *
 * Idempotent — UPSERT by (tenant_id, period_type, period_start).
 * Never crashes the batch — per-(tenant, type) try/catch.
 */

import "dotenv/config";
import { and, asc, eq, gte, lte } from "drizzle-orm";

import { db } from "../db/client";
import {
  analyticsDailySnapshots,
  scheduledReports,
  tenants,
} from "../db/schema";
import {
  composeScheduledReportBody,
  periodBoundsFor,
  type ReportPeriodType,
} from "../lib/analytics/scheduledReports";
import { loadRepeatCustomerForComparison } from "../lib/analytics/customerIntelligence";
import type { DailyAggregate, SnapshotExtras } from "../lib/analytics/types";

(async () => {
  try {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const yesterdayUtc = new Date(todayUtc.getTime() - 24 * 60 * 60_000);

    // Determine cadences active for this run.
    const forced = (process.env.PERIOD_TYPES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const cadences: ReportPeriodType[] = [];
    if (forced.length > 0) {
      for (const f of forced) {
        if (["daily", "weekly", "monthly"].includes(f)) cadences.push(f as ReportPeriodType);
      }
    } else {
      cadences.push("daily");
      if (todayUtc.getUTCDay() === 1) cadences.push("weekly"); // Monday
      if (todayUtc.getUTCDate() === 1) cadences.push("monthly");
    }

    if (cadences.length === 0) {
      console.log(`[reports] no cadences active for ${todayUtc.toISOString()}`);
      process.exit(0);
    }

    const tenantRows = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
    let ok = 0;
    let failed = 0;
    for (const t of tenantRows) {
      for (const periodType of cadences) {
        const start = Date.now();
        try {
          const bounds = periodBoundsFor(periodType, yesterdayUtc);
          const startStr = bounds.start.toISOString().slice(0, 10);
          const endStr = bounds.end.toISOString().slice(0, 10);

          // Pull snapshots covering the period plus the immediately
          // prior period (for executive comparison).
          const priorStart = new Date(bounds.start.getTime() - bounds.days * 24 * 60 * 60_000);
          const priorStartStr = priorStart.toISOString().slice(0, 10);

          const snapshotRows = await db
            .select()
            .from(analyticsDailySnapshots)
            .where(
              and(
                eq(analyticsDailySnapshots.tenantId, t.id),
                gte(analyticsDailySnapshots.snapshotDate, priorStartStr),
                lte(analyticsDailySnapshots.snapshotDate, endStr)
              )
            )
            .orderBy(asc(analyticsDailySnapshots.snapshotDate));

          const all: DailyAggregate[] = snapshotRows.map((r) => ({
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

          const currentPeriod = all.filter((s) => s.snapshotDate >= startStr);

          const repeatCustomerData = await loadRepeatCustomerForComparison({
            tenantId: t.id,
            currentStart: bounds.start,
            currentEnd: bounds.end,
            prevStart: priorStart,
            prevEnd: bounds.start,
          });

          const body = composeScheduledReportBody({
            periodType,
            periodStart: startStr,
            periodEnd: endStr,
            windowWithPriorPeriod: all,
            currentPeriodSnapshots: currentPeriod,
            repeatCustomerData,
          });

          // UPSERT by (tenant, type, start).
          const existing = await db.query.scheduledReports.findFirst({
            where: and(
              eq(scheduledReports.tenantId, t.id),
              eq(scheduledReports.periodType, periodType),
              eq(scheduledReports.periodStart, startStr)
            ),
          });
          if (existing) {
            await db
              .update(scheduledReports)
              .set({
                periodEnd: endStr,
                body,
                generationMs: Date.now() - start,
                generatedAt: new Date(),
              })
              .where(eq(scheduledReports.id, existing.id));
          } else {
            await db.insert(scheduledReports).values({
              tenantId: t.id,
              periodType,
              periodStart: startStr,
              periodEnd: endStr,
              body,
              generationMs: Date.now() - start,
            });
          }
          ok++;
        } catch (e) {
          console.error(`[reports] (${t.name}, ${periodType}) failed:`, e);
          failed++;
        }
      }
    }
    console.log(
      `[reports] tenants=${tenantRows.length} cadences=${cadences.join(",")} ok=${ok} failed=${failed}`
    );
    process.exit(0);
  } catch (e) {
    console.error("[reports] worker crashed:", e);
    process.exit(1);
  }
})();
