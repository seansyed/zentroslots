/**
 * Phase SMART-3 — admin observability aggregator for the
 * communication intelligence dashboard.
 *
 * Pure I/O — reads from bookings + communication_logs + uses the
 * SMART-3 engagement aggregator. No new schema.
 *
 * The endpoint serving this lives at
 * /api/tenant/communications/intelligence (admin/manager only).
 */

import { and, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";

import {
  loadHighRiskCustomers,
  loadReminderChannelHealth,
} from "./engagementSignals";
import { buildAssessmentFromScore } from "./attendancePrediction";
import type {
  CommunicationIntelligenceMetrics,
} from "./types";

const WINDOW_DAYS = 30;
const UPCOMING_DAYS = 7;

export async function computeCommunicationMetrics(
  tenantId: string,
): Promise<CommunicationIntelligenceMetrics> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const upcomingEnd = new Date(now.getTime() + UPCOMING_DAYS * 86_400_000);

  // ─── Attendance counts ──────────────────────────────────────────
  const attendanceRows = await db
    .select({
      status: bookings.status,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        gte(bookings.startAt, windowStart),
        lt(bookings.startAt, now),
      ),
    );

  let completed = 0;
  let noShow = 0;
  for (const r of attendanceRows) {
    if (r.status === "completed") completed++;
    else if (r.status === "no_show") noShow++;
  }
  const observed = completed + noShow;
  const attendanceRatePct =
    observed === 0 ? 100 : Math.round((completed / observed) * 100);

  // ─── Reminder channel health ───────────────────────────────────
  const reminders = await loadReminderChannelHealth({
    tenantId,
    windowDays: WINDOW_DAYS,
  });
  // "Effectiveness" = sent / (sent + suppressed + failed). It's a
  // delivery proxy, not a true open rate (we don't track opens yet).
  const reminderTotal = reminders.sent + reminders.suppressed + reminders.failed;
  const effectivenessPct =
    reminderTotal === 0
      ? 0
      : Math.round((reminders.sent / reminderTotal) * 100);

  // ─── High-risk customers ───────────────────────────────────────
  const highRiskCustomers = await loadHighRiskCustomers({
    tenantId,
    limit: 10,
  });

  // ─── Upcoming high-risk bookings ───────────────────────────────
  const upcomingRows = await db
    .select({
      id: bookings.id,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
      startAt: bookings.startAt,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        gte(bookings.startAt, now),
        lt(bookings.startAt, upcomingEnd),
        eq(bookings.status, "confirmed"),
      ),
    )
    .limit(200);

  // Index high-risk customers by email for O(1) lookup.
  const byEmail = new Map(highRiskCustomers.map((c) => [c.email, c]));

  const upcomingHighRiskBookings = upcomingRows
    .map((r) => {
      const customer = byEmail.get(r.clientEmail.toLowerCase());
      // Coarse signal-build inline — for the dashboard we don't
      // need the per-booking DB lookup that computeAttendanceRisk
      // does; we have aggregate noShow counts already.
      const RESCHEDULE_GAP_MS = 60 * 60_000;
      const rescheduleCount =
        r.updatedAt.getTime() - r.createdAt.getTime() > RESCHEDULE_GAP_MS
          ? 1
          : 0;
      const leadHours = Math.max(
        0,
        (r.startAt.getTime() - now.getTime()) / 3_600_000,
      );
      const assessment = buildAssessmentFromScore({
        signals: {
          leadHours,
          priorCancellations: customer?.cancelledBookings ?? 0,
          priorNoShows: customer?.noShowBookings ?? 0,
          rescheduleCount,
          reminderSuppressed: false,
          missedConfirmation: false,
        },
        now,
      });
      return {
        bookingId: r.id,
        clientName: r.clientName,
        clientEmail: r.clientEmail,
        startAt: r.startAt.toISOString(),
        riskTier: assessment.tier,
        riskScore: assessment.score,
        reasons: assessment.reasons,
      };
    })
    .filter((b) => b.riskTier !== "low")
    .sort((a, b) => b.riskScore - a.riskScore)
    .slice(0, 10);

  return {
    tenantId,
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    reminders: {
      sent: reminders.sent,
      suppressed: reminders.suppressed,
      failed: reminders.failed,
      effectivenessPct,
    },
    attendance: {
      completedBookings: completed,
      noShowBookings: noShow,
      attendanceRatePct,
    },
    highRiskCustomers,
    upcomingHighRiskBookings,
  };
}
