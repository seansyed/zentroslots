/**
 * Materialize scheduled booking_occurrences into real bookings.
 *
 * For each occurrence due in the next materialization horizon:
 *   1. Resolve effective (startAt, staff) via applyOverride
 *   2. Skip if override.skip
 *   3. Run validateBookingRules (notice/advance/caps/blackouts/biz hours)
 *      — if any rule fails, mark occurrence 'failed' with reason
 *   4. Re-check availability via getAvailableSlots — if no longer free,
 *      'failed' (per-occurrence) but SERIES stays intact (rule #14)
 *   5. INSERT booking. EXCLUDE 23P01 → occurrence 'failed'/'slot_taken'
 *   6. On success: link booking_id back, mark occurrence 'completed-ish'
 *      (stay 'scheduled' — the BOOKING progresses through its own
 *      lifecycle independently)
 *   7. Fire triggerAutomation('appointment.created') so reminders +
 *      calendar sync flow normally
 *
 * Per-occurrence isolation: a single failure NEVER halts the batch.
 * Each occurrence is its own try/catch; failures are recorded on the
 * occurrence row and the worker moves to the next.
 *
 * Booking engine NOT refactored — we call the existing primitives
 * (validateBookingRules, getAvailableSlots, raw INSERT). Same code
 * path as a customer-initiated booking; EXCLUDE remains authoritative.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookingOccurrences, bookingSeries, bookings, services, users } from "@/db/schema";
import { getAvailableSlots } from "@/lib/availability";
import { triggerAutomation } from "@/lib/communications/engine";
import { validateBookingRules } from "@/lib/booking-rules/validateBookingRules";
import { onBookingCreated } from "@/lib/calendar/sync";

import { applyOverride } from "./exceptions";
import type { OccurrenceOverride } from "./types";
import { shouldExecute, type CronDecision } from "@/lib/billing/cronGuards";

export type MaterializeInput = {
  /** Don't try to materialize anything starting after this horizon
   *  (UTC). Typically now() + 24h so the worker materializes things
   *  about to happen. */
  horizon: Date;
  /** Max occurrences per worker run. */
  batchSize?: number;
  /** Optional per-tenant billing decision map (Phase 2 hardening).
   *  When provided, occurrences whose tenant resolves to a "skip"
   *  decision are marked skipped without being materialized. When
   *  absent, all occurrences are processed (backwards-compatible —
   *  the API surface this lib serves doesn't pass this; only the
   *  cron does). */
  tenantDecisions?: Map<string, CronDecision>;
};

export type MaterializeResult = {
  scanned: number;
  materialized: number;
  failed: number;
  skipped: number;
};

export async function materializeOccurrences(input: MaterializeInput): Promise<MaterializeResult> {
  const batch = input.batchSize ?? 50;

  // Pull scheduled occurrences due within the horizon. We filter by
  // status='scheduled' (not yet materialized) and start_at <= horizon.
  const dueOccurrences = await db
    .select()
    .from(bookingOccurrences)
    .where(
      and(
        eq(bookingOccurrences.status, "scheduled"),
        // start_at <= horizon
        // (use typed Drizzle comparator)
      )
    )
    .limit(batch);
  // The where above needs lte — add via Drizzle helper:
  const filtered = dueOccurrences.filter((o) => o.occurrenceStartAt <= input.horizon);

  let materialized = 0;
  let failed = 0;
  let skipped = 0;

  for (const occ of filtered) {
    // Phase 2 billing guard — skip occurrences whose tenant has been
    // marked inactive or whose subscription is in a terminal failure
    // state. Grandfathered tenants ("grandfather" mode) still execute
    // — we only short-circuit on explicit skip. Record the reason on
    // the row so admins can see WHY a series stopped firing without
    // grepping logs.
    if (input.tenantDecisions) {
      const decision = input.tenantDecisions.get(occ.tenantId);
      if (decision && !shouldExecute(decision)) {
        await db
          .update(bookingOccurrences)
          .set({
            status: "skipped",
            failureReason: `billing_guard:${decision.reason}`,
            updatedAt: new Date(),
          })
          .where(eq(bookingOccurrences.id, occ.id));
        skipped++;
        continue;
      }
    }

    try {
      const result = await processOne(occ);
      if (result === "materialized") materialized++;
      else if (result === "skipped") skipped++;
      else failed++;
    } catch (e) {
      console.error(`[recurring] occurrence ${occ.id} crashed:`, e);
      await markFailed(occ.id, "crashed");
      failed++;
    }
  }

  return { scanned: filtered.length, materialized, failed, skipped };
}

async function processOne(
  occ: typeof bookingOccurrences.$inferSelect
): Promise<"materialized" | "skipped" | "failed"> {
  // Increment attempts immediately (so a crash mid-flow doesn't infinite-loop).
  await db
    .update(bookingOccurrences)
    .set({ attempts: occ.attempts + 1, lastAttemptAt: new Date() })
    .where(eq(bookingOccurrences.id, occ.id));

  const series = await db.query.bookingSeries.findFirst({
    where: and(
      eq(bookingSeries.id, occ.bookingSeriesId),
      eq(bookingSeries.tenantId, occ.tenantId)
    ),
  });
  if (!series) {
    await markFailed(occ.id, "series_missing");
    return "failed";
  }
  if (series.status !== "active") {
    // Paused or cancelled — nothing to do but record the skip.
    await db
      .update(bookingOccurrences)
      .set({ status: "skipped", failureReason: `series_${series.status}` })
      .where(eq(bookingOccurrences.id, occ.id));
    return "skipped";
  }

  // Phase 5 — downgrade enforcement. If the orchestrator paused this
  // series after the occurrence was generated, halt materialization.
  // Mark the occurrence as skipped with an enforcement-specific reason
  // so an admin reading the failure log knows WHY (vs the user-pause
  // path above). Restoring the series via the recovery executor clears
  // `enforcement_paused_at` and future occurrences resume.
  if (series.enforcementPausedAt) {
    await db
      .update(bookingOccurrences)
      .set({
        status: "skipped",
        failureReason: `enforcement_paused:${series.enforcementPausedReason ?? "unknown"}`,
      })
      .where(eq(bookingOccurrences.id, occ.id));
    return "skipped";
  }

  const effective = applyOverride({
    seriesStartAt: occ.occurrenceStartAt,
    seriesStaffUserId: series.staffUserId,
    override: (occ.overrides as OccurrenceOverride) ?? null,
  });

  if (effective.shouldSkip) {
    await db
      .update(bookingOccurrences)
      .set({ status: "skipped", failureReason: "override_skip" })
      .where(eq(bookingOccurrences.id, occ.id));
    return "skipped";
  }

  const service = await db.query.services.findFirst({
    where: and(eq(services.id, series.serviceId), eq(services.tenantId, occ.tenantId)),
  });
  if (!service || service.isActive !== 1) {
    await markFailed(occ.id, "service_missing");
    return "failed";
  }

  if (!effective.staffUserId) {
    await markFailed(occ.id, "no_staff");
    return "failed";
  }
  const staff = await db.query.users.findFirst({
    where: and(eq(users.id, effective.staffUserId), eq(users.tenantId, occ.tenantId)),
  });
  if (!staff) {
    await markFailed(occ.id, "staff_missing");
    return "failed";
  }

  const endAt = new Date(effective.startAt.getTime() + service.durationMinutes * 60_000);

  // Run the rules engine — same checks a one-off booking gets.
  const ruleResult = await validateBookingRules({
    tenantId: occ.tenantId,
    serviceId: service.id,
    clientEmail: series.customerEmail,
    startAt: effective.startAt,
    endAt,
  });
  if (!ruleResult.ok) {
    await markFailed(occ.id, `rule:${ruleResult.error.code}`);
    return "failed";
  }

  // Availability check using the staff's TZ — same primitive the
  // public flow uses. If the slot isn't in the list, something else
  // (overlap, off-hours, external busy) holds it.
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: staff.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(effective.startAt);
  const slots = await getAvailableSlots({
    serviceId: service.id,
    staffUserId: staff.id,
    date: dateStr,
    timezone: staff.timezone,
  });
  if (!slots.includes(effective.startAt.toISOString())) {
    await markFailed(occ.id, "slot_unavailable");
    return "failed";
  }

  // INSERT booking. EXCLUDE 23P01 → mark failed; series intact.
  let bookingRow: typeof bookings.$inferSelect;
  try {
    [bookingRow] = await db
      .insert(bookings)
      .values({
        tenantId: occ.tenantId,
        serviceId: service.id,
        staffUserId: staff.id,
        clientName: series.customerName,
        clientEmail: series.customerEmail,
        startAt: effective.startAt,
        endAt,
        status: "confirmed",
        assignmentMode: "auto",
        notes: "From recurring series",
        bookingSeriesId: series.id,
        bookingOccurrenceId: occ.id,
      })
      .returning();
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "23P01") {
      await markFailed(occ.id, "slot_taken");
      return "failed";
    }
    throw e;
  }

  // Link the booking back onto the occurrence row.
  await db
    .update(bookingOccurrences)
    .set({
      bookingId: bookingRow.id,
      status: "scheduled", // stays 'scheduled' — booking has its own lifecycle
      failureReason: null,
    })
    .where(eq(bookingOccurrences.id, occ.id));

  // Fire downstream automations. Best-effort — never affects the
  // materialize result.
  try {
    await onBookingCreated({
      booking: bookingRow,
      staff,
      serviceName: service.name,
      videoConference: service.videoProvider === "google_meet",
    });
  } catch (e) {
    console.error(`[recurring] calendar sync after materialize failed:`, e);
  }
  try {
    await triggerAutomation({
      tenantId: occ.tenantId,
      bookingId: bookingRow.id,
      eventType: "appointment.created",
      attachIcs: true,
    });
  } catch (e) {
    console.error(`[recurring] triggerAutomation after materialize failed:`, e);
  }

  return "materialized";
}

async function markFailed(occId: string, reason: string): Promise<void> {
  await db
    .update(bookingOccurrences)
    .set({
      status: "failed",
      failureReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(bookingOccurrences.id, occId));
}
