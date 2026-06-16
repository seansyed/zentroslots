/**
 * Shared reschedule engine — single source of truth for both the public
 * token-gated route (/api/public/booking/[token]/reschedule) and the
 * authenticated portal route (/api/client/[slug]/bookings/[bookingId]/reschedule).
 *
 * Both call sites converge on this helper so behavior is identical:
 *   1. Tenant feature gate ("rescheduling" must be on)
 *   2. Booking load + terminal-state guard
 *   3. Transactional re-slot:
 *        - flip current row to status='pending' (frees the EXCLUDE slot)
 *        - re-compute available slots for the new date in the staff TZ
 *        - if requested startAt isn't in the available set → 409
 *        - otherwise update startAt/endAt + clear reminder timestamps
 *   4. External calendar sync (best-effort)
 *   5. Waitlist release for the OLD slot (best-effort)
 *   6. Customer email (gated by prefs, best-effort)
 *
 * Returns a discriminated result so callers can map to HTTP status
 * codes cleanly. NEVER mutates the booking on failure — the
 * transaction guarantees that.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { isFeatureEnabled } from "@/lib/features";
import { onBookingRescheduled } from "@/lib/calendar/sync";
import { releaseSlot } from "@/lib/waitlists/releaseSlot";
import { notifySlotAvailable } from "@/lib/waitlists/notifications";
import { getAvailableSlots } from "@/lib/availability";
import { triggerAutomation } from "@/lib/communications/engine";

export type RescheduleSource = "public_token" | "portal";

export type RescheduleResult =
  | {
      ok: true;
      booking: typeof bookings.$inferSelect;
      service: typeof services.$inferSelect;
      staff: typeof users.$inferSelect;
    }
  | {
      ok: false;
      status: number;
      error: string;
    };

export type RescheduleArgs = {
  bookingId: string;
  tenantId: string;
  /** ISO string for the new start time. */
  newStartIso: string;
  /** Caller identifier; recorded in best-effort logs. */
  source: RescheduleSource;
};

/**
 * Performs the reschedule end-to-end. Caller is responsible ONLY for
 * authorization (token verify OR session verify) and returning the
 * HTTP response.
 */
export async function performReschedule(args: RescheduleArgs): Promise<RescheduleResult> {
  // ── 1. Feature gate ─────────────────────────────────────────────
  if (!(await isFeatureEnabled(args.tenantId, "rescheduling"))) {
    return {
      ok: false,
      status: 403,
      error: "Rescheduling is no longer available for this booking",
    };
  }

  // ── 2. Booking load + terminal-state guard ──────────────────────
  const newStart = new Date(args.newStartIso);
  if (Number.isNaN(newStart.getTime())) {
    return { ok: false, status: 400, error: "Invalid startAt" };
  }

  const existing = await db.query.bookings.findFirst({
    where: and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)),
  });
  if (!existing) {
    return { ok: false, status: 404, error: "Booking not found" };
  }
  if (existing.status === "cancelled" || existing.status === "completed") {
    return { ok: false, status: 409, error: "Booking is in a terminal state" };
  }

  const [service, staff] = await Promise.all([
    db.query.services.findFirst({ where: eq(services.id, existing.serviceId) }),
    db.query.users.findFirst({ where: eq(users.id, existing.staffUserId) }),
  ]);
  if (!service || !staff) {
    return { ok: false, status: 404, error: "Service or staff missing" };
  }

  // Compute the calendar date in the staff's timezone — the engine
  // groups slots by tenant/staff-local day, not UTC day.
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: staff.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(newStart);

  // ── 3. Transactional re-slot ────────────────────────────────────
  let updated: typeof bookings.$inferSelect | undefined;
  try {
    await db.transaction(async (tx) => {
      // Free the slot the current booking holds so the engine sees it
      // as open when we re-evaluate availability.
      await tx
        .update(bookings)
        .set({ status: "pending" })
        .where(and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)));

      const slots = await getAvailableSlots({
        serviceId: service.id,
        staffUserId: staff.id,
        date,
        timezone: staff.timezone,
      });
      if (!slots.includes(newStart.toISOString())) {
        // Throw to roll back; caught below to return a 409.
        const e = new Error("Slot not available");
        (e as { __status?: number }).__status = 409;
        throw e;
      }

      const newEnd = new Date(newStart.getTime() + service.durationMinutes * 60_000);
      const result = await tx
        .update(bookings)
        .set({
          startAt: newStart,
          endAt: newEnd,
          status: "confirmed",
          // Clear reminder marks so the cron resends 24h/1h reminders
          // relative to the NEW time. Prevents orphaned reminders.
          reminder24hSentAt: null,
          reminder1hSentAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)))
        .returning();
      updated = result[0];
    });
  } catch (e: unknown) {
    // Drizzle/Postgres EXCLUDE conflict code from the overlap constraint
    // (set up in migration 0001).
    const code = (e as { code?: string })?.code;
    const explicit = (e as { __status?: number })?.__status;
    if (code === "23P01" || explicit === 409) {
      return { ok: false, status: 409, error: "Slot just taken — pick another" };
    }
    throw e;
  }

  if (!updated) {
    return { ok: false, status: 500, error: "Reschedule failed" };
  }

  // ── 4. Calendar sync (best-effort) ──────────────────────────────
  try {
    await onBookingRescheduled({ booking: updated, staff, serviceName: service.name });
  } catch (gErr) {
    console.error(`[reschedule:${args.source}] calendar sync failed (booking kept):`, gErr);
  }

  // ── 5. Waitlist release for the OLD slot (best-effort) ──────────
  try {
    const release = await releaseSlot({
      tenantId: existing.tenantId,
      serviceId: existing.serviceId,
      staffUserId: existing.staffUserId,
      slotStartAt: existing.startAt,
      slotEndAt: existing.endAt,
      originatingBookingId: existing.id,
    });
    if (release.ok) {
      await notifySlotAvailable({
        tenantId: existing.tenantId,
        bookingId: existing.id,
        customerEmail: release.customerEmail,
        claimUrl: release.claimUrl,
        expiresAt: release.expiresAt,
        staffTimezone: staff.timezone,
      });
    }
  } catch (wlErr) {
    console.error(`[reschedule:${args.source}] waitlist release failed:`, wlErr);
  }

  // ── 6. Customer email (via the engine — pref gate + idempotency + ICS) ──
  // dedupeKey = the NEW start instant: each legitimate move emails once,
  // while a retry of the SAME move (same new time) dedups. The engine owns
  // the customer-preference gate, template resolution, token signing, the
  // communication_logs row, and the ICS attachment.
  try {
    await triggerAutomation({
      tenantId: updated.tenantId,
      bookingId: updated.id,
      eventType: "appointment.rescheduled",
      attachIcs: true,
      dedupeKey: `r:${updated.startAt.getTime()}`,
    });
  } catch (e) {
    console.error(`[reschedule:${args.source}] automation failed:`, e);
  }

  return { ok: true, booking: updated, service, staff };
}
