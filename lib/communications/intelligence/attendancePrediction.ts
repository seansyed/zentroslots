/**
 * Phase SMART-3 — attendance prediction adapter.
 *
 * Wraps the existing pure scoreNoShowRisk() (Phase 71) and supplies
 * it with computed signals from per-booking + per-customer history.
 * The underlying scorer is untouched.
 *
 * The adapter is the integration point the booking dashboard +
 * admin observability endpoint use. Pure with respect to its inputs;
 * the DB I/O is in two clearly-bounded helpers that callers can
 * test by injecting fixture data.
 */

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";
import {
  scoreNoShowRisk,
  type BookingSignals,
} from "@/lib/analytics/noShowRisk";

import type {
  AttendanceRiskAssessment,
  AttendanceRiskTier,
} from "./types";

/** Pure mapper — given the existing scoreNoShowRisk output, produce
 *  the SMART-3 AttendanceRiskAssessment shape (which adds leadHours
 *  + signals echo for the admin diagnostics drawer). */
export function buildAssessmentFromScore(args: {
  signals: BookingSignals;
  now?: Date;
}): AttendanceRiskAssessment {
  const now = args.now ?? new Date();
  const { tier, score, reasons } = scoreNoShowRisk(args.signals);
  return {
    score,
    tier: tier as AttendanceRiskTier,
    reasons,
    leadHours: args.signals.leadHours,
    signals: {
      priorCancellations: args.signals.priorCancellations,
      priorNoShows: args.signals.priorNoShows,
      rescheduleCount: args.signals.rescheduleCount,
      reminderSuppressed: args.signals.reminderSuppressed,
      missedConfirmation: args.signals.missedConfirmation,
    },
    generatedAt: now.toISOString(),
  };
}

/** Build the BookingSignals struct for one booking via prior-history
 *  aggregation. Tenant-scoped via the (tenantId, lower clientEmail)
 *  WHERE clause. */
export async function buildBookingSignalsFromDb(args: {
  tenantId: string;
  bookingId: string;
  clientEmail: string;
  bookingStartAt: Date;
  bookingCreatedAt: Date;
  bookingUpdatedAt: Date;
  /** Whether THIS booking has reminders suppressed (customer prefs).
   *  Caller passes this — the adapter doesn't peek at customer_prefs. */
  reminderSuppressed: boolean;
}): Promise<BookingSignals> {
  // Count PRIOR (i.e. NOT THIS) bookings' cancellations + no-shows
  // for this customer in this tenant. We exclude the current booking
  // by id to avoid double-counting if the customer has been
  // cancelled already.
  const rows = await db
    .select({
      status: bookings.status,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        sql`lower(${bookings.clientEmail}) = ${args.clientEmail.toLowerCase()}`,
        sql`${bookings.id} <> ${args.bookingId}`,
      ),
    )
    .limit(500);

  let priorCancellations = 0;
  let priorNoShows = 0;
  for (const r of rows) {
    if (r.status === "cancelled") priorCancellations++;
    else if (r.status === "no_show") priorNoShows++;
  }

  // Reschedule heuristic for THIS booking: confirmed/pending status
  // where updatedAt is materially after createdAt suggests at least
  // one prior reschedule. Matches the heuristic used in
  // engagementSignals.ts so the two views agree.
  const RESCHEDULE_GAP_MS = 60 * 60_000;
  const rescheduleCount =
    args.bookingUpdatedAt.getTime() - args.bookingCreatedAt.getTime() > RESCHEDULE_GAP_MS
      ? 1
      : 0;

  // Lead time: hours from now → booking start (caller is querying
  // for an UPCOMING booking). For past bookings this can be negative;
  // we clamp at 0 so the scorer treats the "very short lead" branch
  // as the worst case.
  const leadHours = Math.max(
    0,
    (args.bookingStartAt.getTime() - Date.now()) / 3_600_000,
  );

  return {
    leadHours,
    priorCancellations,
    priorNoShows,
    rescheduleCount,
    reminderSuppressed: args.reminderSuppressed,
    // missedConfirmation is a proxy — for now we leave it false
    // since we don't have email-open tracking wired. Future work
    // can flip this when the email provider's open-pixel hits us.
    missedConfirmation: false,
  };
}

/** End-to-end: load booking + signals + run scorer. Returns null
 *  when the booking can't be loaded (deleted, wrong tenant, etc.). */
export async function computeAttendanceRisk(args: {
  tenantId: string;
  bookingId: string;
}): Promise<AttendanceRiskAssessment | null> {
  const [row] = await db
    .select({
      id: bookings.id,
      tenantId: bookings.tenantId,
      clientEmail: bookings.clientEmail,
      startAt: bookings.startAt,
      createdAt: bookings.createdAt,
      updatedAt: bookings.updatedAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.id, args.bookingId),
        eq(bookings.tenantId, args.tenantId),
      ),
    )
    .limit(1);
  if (!row) return null;

  const signals = await buildBookingSignalsFromDb({
    tenantId: row.tenantId,
    bookingId: row.id,
    clientEmail: row.clientEmail,
    bookingStartAt: row.startAt,
    bookingCreatedAt: row.createdAt,
    bookingUpdatedAt: row.updatedAt,
    // Caller responsible for resolving customer prefs separately;
    // for the admin view we default to false. (The reminders cron
    // applies its own prefs check before sending.)
    reminderSuppressed: false,
  });

  return buildAssessmentFromScore({ signals });
}
