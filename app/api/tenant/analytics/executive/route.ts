import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";

import { db } from "@/db/client";
import { analyticsDailySnapshots } from "@/db/schema";
import { errorResponse } from "@/lib/auth";
import { requirePermissionOrRole } from "@/lib/security/permissions";
import { buildExecutiveSummary } from "@/lib/analytics/executiveMetrics";
import {
  aggregateLocationAnalytics,
  aggregateDepartmentAnalytics,
} from "@/lib/analytics/locationAnalytics";
import {
  aggregateCustomerIntelligence,
  loadRepeatCustomerForComparison,
} from "@/lib/analytics/customerIntelligence";
import type { DailyAggregate, SnapshotExtras } from "@/lib/analytics/types";

// GET /api/tenant/analytics/executive?range=60
//
// Returns the executive payload: KPIs (this period vs prior), per-
// location + per-department rollups, customer intelligence. Tenant-
// isolated. Read-only.
//
// Range default is 60 days so the executive comparison has 30 vs 30.
const DEFAULT_DAYS = 60;
const MAX_DAYS = 365;

export async function GET(req: NextRequest) {
  try {
    const admin = await requirePermissionOrRole({
      allowRoles: ["admin", "manager"],
      requirePermission: "canViewExecutiveAnalytics",
      auditPath: "/api/tenant/analytics/executive",
    });
    const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? DEFAULT_DAYS);
    const days = Math.max(14, Math.min(MAX_DAYS, isFinite(rangeParam) ? rangeParam : DEFAULT_DAYS));

    const today = new Date();
    const cutoff = new Date(today.getTime() - days * 24 * 60 * 60_000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);

    const snapshotRows = await db
      .select()
      .from(analyticsDailySnapshots)
      .where(
        and(
          eq(analyticsDailySnapshots.tenantId, admin.tenantId),
          gte(analyticsDailySnapshots.snapshotDate, cutoffStr),
          lte(analyticsDailySnapshots.snapshotDate, todayStr)
        )
      )
      .orderBy(asc(analyticsDailySnapshots.snapshotDate));

    const snapshots: DailyAggregate[] = snapshotRows.map((r) => ({
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

    // Compute the windows: current = last half, previous = prior half.
    const halfDays = Math.floor(days / 2);
    const currentStart = new Date(today.getTime() - halfDays * 24 * 60 * 60_000);
    const currentEnd = today;
    const prevStart = new Date(today.getTime() - days * 24 * 60 * 60_000);
    const prevEnd = currentStart;

    // Repeat-customer data feeds executive metrics. DB-touching helper
    // is tenant-scoped + never-throws.
    const repeatCustomerData = await loadRepeatCustomerForComparison({
      tenantId: admin.tenantId,
      currentStart,
      currentEnd,
      prevStart,
      prevEnd,
    });

    const executive = buildExecutiveSummary(snapshots, repeatCustomerData);

    // Location + department rollups (current period only).
    const [locationRollup, departmentRollup, customerIntel] = await Promise.all([
      aggregateLocationAnalytics({
        tenantId: admin.tenantId,
        windowStart: currentStart,
        windowEnd: currentEnd,
      }),
      aggregateDepartmentAnalytics({
        tenantId: admin.tenantId,
        windowStart: currentStart,
        windowEnd: currentEnd,
      }),
      aggregateCustomerIntelligence({
        tenantId: admin.tenantId,
        windowStart: currentStart,
        windowEnd: currentEnd,
      }),
    ]);

    return NextResponse.json({
      range: { days, from: cutoffStr, to: todayStr },
      executive,
      locations: locationRollup,
      departments: departmentRollup,
      customerIntelligence: customerIntel,
      snapshotCount: snapshots.length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
