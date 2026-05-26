/**
 * Phase SMART-3 — per-booking attendance risk endpoint.
 *
 *   GET /api/bookings/:id/attendance-risk
 *
 * Admin/manager/staff only — staff need to see risk for bookings
 * assigned to them. Returns the full AttendanceRiskAssessment for
 * the admin booking drawer + a small set of deterministic message
 * recommendations.
 *
 * Read-only. Does not affect any reminder/email behavior.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";
import { computeAttendanceRisk } from "@/lib/communications/intelligence/attendancePrediction";
import { loadCustomerEngagementProfile } from "@/lib/communications/intelligence/engagementSignals";
import { recommendMessages } from "@/lib/communications/intelligence/messageRecommendations";
import { computeReminderCadence } from "@/lib/communications/intelligence/communicationTiming";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const caller = await requireRole(["admin", "manager", "staff"]);
    const { id } = await context.params;

    // Load + tenant-scope the booking; staff role still bound to
    // their tenant by requireRole().
    const [row] = await db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.id, id),
          eq(bookings.tenantId, caller.tenantId),
        ),
      )
      .limit(1);
    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const risk = await computeAttendanceRisk({
      tenantId: caller.tenantId,
      bookingId: row.id,
    });
    if (!risk) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Engagement profile (may be null for first-time customers).
    const engagement = await loadCustomerEngagementProfile({
      tenantId: caller.tenantId,
      customerEmail: row.clientEmail,
    });

    // Deterministic operator hints + recommended reminder cadence
    // (both informational — neither changes send behavior).
    const messageRecommendations = recommendMessages({
      risk,
      engagement,
      leadHours: risk.leadHours,
    });
    const cadence = computeReminderCadence({
      bookingStartAt: row.startAt,
      leadHours: risk.leadHours,
      risk,
    });

    return NextResponse.json({
      bookingId: row.id,
      risk,
      engagement,
      messageRecommendations,
      cadence,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
