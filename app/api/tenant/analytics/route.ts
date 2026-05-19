import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";

import { db } from "@/db/client";
import { analyticsDailySnapshots } from "@/db/schema";
import { errorResponse } from "@/lib/auth";
import { requirePermissionOrRole } from "@/lib/security/permissions";
import { generateInsights } from "@/lib/analytics/insights";
import type { DailyAggregate, SnapshotExtras } from "@/lib/analytics/types";

// GET /api/tenant/analytics?range=30
//
// Returns the snapshot window + computed insights for the caller-tenant.
// Tenant-isolated. Never errors when no snapshots exist — returns
// empty arrays so the dashboard can fall back to live queries.
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export async function GET(req: NextRequest) {
  try {
    // Granular gate: canViewExecutiveAnalytics (admin + manager have
    // it by default — back-compat). allowRoles is kept so a legacy
    // admin/manager passes even if a per-user override revoked the
    // flag from them.
    const admin = await requirePermissionOrRole({
      allowRoles: ["admin", "manager"],
      requirePermission: "canViewExecutiveAnalytics",
      auditPath: "/api/tenant/analytics",
    });
    const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? DEFAULT_DAYS);
    const days = Math.max(1, Math.min(MAX_DAYS, isFinite(rangeParam) ? rangeParam : DEFAULT_DAYS));

    const today = new Date();
    const cutoff = new Date(today.getTime() - days * 24 * 60 * 60_000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);

    const rows = await db
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

    const aggregates: DailyAggregate[] = rows.map((r) => ({
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

    const insights = generateInsights(aggregates);

    return NextResponse.json({
      range: { days, from: cutoffStr, to: todayStr },
      snapshots: aggregates,
      insights,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
