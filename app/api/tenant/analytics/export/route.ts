import { NextRequest } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";

import { db } from "@/db/client";
import { analyticsDailySnapshots } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

// GET /api/tenant/analytics/export?range=30
//
// Returns the snapshots in CSV form. Tenant-isolated. One row per day
// with all top-level snapshot counts. Skips extras jsonb (those are
// rendered in the dashboard but unwieldy in CSV).
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export async function GET(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
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

    const header = [
      "date",
      "total_bookings",
      "completed",
      "cancelled",
      "no_show",
      "recurring",
      "waitlist_joins",
      "waitlist_conversions",
      "review_requests_sent",
      "reminder_emails_sent",
      "reminder_emails_suppressed",
      "followups_sent",
      "avg_lead_hours",
      // Revenue columns (additive — empty for tenants without
      // billing_transactions on that day).
      "gross_revenue_cents",
      "refunded_revenue_cents",
      "net_revenue_cents",
      "successful_payments",
      "failed_payments",
      "avg_booking_value_cents",
      // Forecasting + intelligence (populated on rows where the
      // aggregation worker computed trailing-window intelligence —
      // typically the latest day per tenant).
      "projected_bookings_30d",
      "projected_revenue_30d_cents",
      "staffing_pressure_level",
      "trend_direction",
      "forecast_confidence",
    ];

    type ForecastingExtras = {
      projectedBookingsNext30Days: number;
      projectedRevenueNext30Days: number;
      staffingPressureLevel: string;
      trendDirection: string;
      confidenceScore: number;
    };

    type RevenueExtras = {
      grossRevenueCents: number;
      refundedRevenueCents: number;
      netRevenueCents: number;
      successfulPayments: number;
      failedPayments: number;
      avgBookingValueCents: number;
    };

    const lines = [header.join(",")];
    for (const r of rows) {
      const extras =
        r.extras && typeof r.extras === "object" && !Array.isArray(r.extras)
          ? (r.extras as { revenue?: RevenueExtras; forecasting?: ForecastingExtras })
          : null;
      const rev = extras?.revenue;
      const fc = extras?.forecasting;
      lines.push(
        [
          r.snapshotDate,
          r.totalBookings,
          r.completedBookings,
          r.cancelledBookings,
          r.noShowBookings,
          r.recurringBookings,
          r.waitlistJoins,
          r.waitlistConversions,
          r.reviewRequestsSent,
          r.reminderEmailsSent,
          r.reminderEmailsSuppressed,
          r.followupsSent,
          r.averageBookingLeadHours ?? "",
          rev?.grossRevenueCents ?? "",
          rev?.refundedRevenueCents ?? "",
          rev?.netRevenueCents ?? "",
          rev?.successfulPayments ?? "",
          rev?.failedPayments ?? "",
          rev?.avgBookingValueCents ?? "",
          fc?.projectedBookingsNext30Days ?? "",
          fc?.projectedRevenueNext30Days ?? "",
          fc?.staffingPressureLevel ?? "",
          fc?.trendDirection ?? "",
          fc?.confidenceScore ?? "",
        ].join(",")
      );
    }

    const body = lines.join("\n") + "\n";
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="analytics-${cutoffStr}-to-${todayStr}.csv"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
