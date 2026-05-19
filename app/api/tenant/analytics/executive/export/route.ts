import { NextRequest } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { db } from "@/db/client";
import { analyticsDailySnapshots } from "@/db/schema";
import { and, asc, eq, gte, lte } from "drizzle-orm";
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

// GET /api/tenant/analytics/executive/export?range=60
//
// Downloadable executive CSV. Single flat row per KPI + multi-section
// breakdowns. Wide; suitable for stakeholder distribution.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const days = Math.max(14, Math.min(365, Number(req.nextUrl.searchParams.get("range") ?? 60)));

    const today = new Date();
    const cutoff = new Date(today.getTime() - days * 24 * 60 * 60_000);
    const halfDays = Math.floor(days / 2);
    const currentStart = new Date(today.getTime() - halfDays * 24 * 60 * 60_000);
    const prevStart = cutoff;

    const snapshotRows = await db
      .select()
      .from(analyticsDailySnapshots)
      .where(
        and(
          eq(analyticsDailySnapshots.tenantId, admin.tenantId),
          gte(analyticsDailySnapshots.snapshotDate, cutoff.toISOString().slice(0, 10)),
          lte(analyticsDailySnapshots.snapshotDate, today.toISOString().slice(0, 10))
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

    const repeatCustomerData = await loadRepeatCustomerForComparison({
      tenantId: admin.tenantId,
      currentStart,
      currentEnd: today,
      prevStart,
      prevEnd: currentStart,
    });
    const executive = buildExecutiveSummary(snapshots, repeatCustomerData);

    const [locs, depts, custIntel] = await Promise.all([
      aggregateLocationAnalytics({ tenantId: admin.tenantId, windowStart: currentStart, windowEnd: today }),
      aggregateDepartmentAnalytics({ tenantId: admin.tenantId, windowStart: currentStart, windowEnd: today }),
      aggregateCustomerIntelligence({ tenantId: admin.tenantId, windowStart: currentStart, windowEnd: today }),
    ]);

    // Build the CSV in three sections.
    const lines: string[] = [];
    lines.push("section,metric,current,previous,percent_change,quality,trend");

    if (executive) {
      const k = (label: string, kpi: typeof executive.bookings) => {
        lines.push(
          [
            "kpi",
            label,
            kpi.comparison.currentValue,
            kpi.comparison.previousValue,
            `${kpi.comparison.percentChange}%`,
            kpi.comparison.quality,
            kpi.trendDirection,
          ].join(",")
        );
      };
      k("bookings", executive.bookings);
      k("revenue_cents", executive.revenue);
      k("cancellations", executive.cancellations);
      k("waitlist_conversions", executive.waitlistConversions);
      k("avg_booking_value_cents", executive.avgBookingValue);
      k("repeat_customer_pct", executive.repeatCustomerPct);
      k("staff_efficiency", executive.staffEfficiency);
    }

    lines.push("");
    lines.push("section,id,name,bookings,completed,cancelled,gross_revenue_cents");
    for (const l of locs) {
      lines.push(["location", l.locationId, l.locationName, l.bookings, l.completed, l.cancelled, l.grossRevenueCents].join(","));
    }
    for (const d of depts) {
      lines.push(["department", d.departmentId, d.departmentName, d.bookings, d.completed, d.cancelled, d.grossRevenueCents].join(","));
    }

    lines.push("");
    lines.push("section,metric,value");
    lines.push(`customer_intelligence,repeat_customer_pct,${custIntel.repeatCustomerRate}`);
    lines.push(`customer_intelligence,retention_pct,${custIntel.retentionRate}`);
    lines.push(`customer_intelligence,new_customers,${custIntel.newCustomersThisPeriod}`);
    lines.push(`customer_intelligence,bookings_by_existing,${custIntel.bookingsByExistingCustomers}`);
    lines.push(`customer_intelligence,bookings_by_new,${custIntel.bookingsByNewCustomers}`);

    const body = lines.join("\n") + "\n";
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="executive-${cutoff.toISOString().slice(0, 10)}-to-${today.toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
