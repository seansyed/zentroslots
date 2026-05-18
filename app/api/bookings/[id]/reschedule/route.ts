import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { errorResponse, isManagerial, requireUser, HttpError } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { onBookingRescheduled } from "@/lib/calendar/sync";
import { bookingRescheduleSchema } from "@/lib/validation";
import { getAvailableSlots } from "@/lib/availability";
import { renderReschedule, sendEmail, type BookingForEmail } from "@/lib/email";
import { gateSchedulingEmail, logSuppressed } from "@/lib/communications/preferences";
import { signBookingToken } from "@/lib/tokens";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    const body = bookingRescheduleSchema.parse(await req.json());

    // Tenant feature gate. When admins turn rescheduling off, the
    // route refuses regardless of role — the UI also hides its button
    // (see TaskCreate task #9) but the API is the security boundary.
    if (!(await isFeatureEnabled(caller.tenantId, "rescheduling"))) {
      throw new HttpError(403, "Rescheduling is disabled for this workspace");
    }

    const booking = await db.query.bookings.findFirst({
      where: and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)),
    });
    if (!booking) throw new HttpError(404, "Booking not found");
    if (!isManagerial(caller.role) && booking.staffUserId !== caller.id) {
      throw new HttpError(403, "Forbidden");
    }
    if (booking.status === "cancelled" || booking.status === "completed") {
      throw new HttpError(409, "Booking is in a terminal state");
    }

    const newStart = new Date(body.startAt);
    if (Number.isNaN(newStart.getTime())) throw new HttpError(400, "Invalid startAt");

    const [service, staff] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, booking.serviceId) }),
      db.query.users.findFirst({ where: eq(users.id, booking.staffUserId) }),
    ]);
    if (!service || !staff) throw new HttpError(404, "Service or staff missing");

    // Validate new slot exists. The engine treats the booking's CURRENT
    // confirmed instance as a blocker, so temporarily mark it cancelled,
    // re-check, then update — simpler than carving out exceptions.
    // We do this inside a single transaction with the EXCLUDE constraint
    // as the final backstop.
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: staff.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(newStart);

    // Quick: free the slot by temporarily setting status to 'pending'
    // (which the constraint ignores), re-check availability, then commit.
    let updated: typeof bookings.$inferSelect | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(bookings)
          .set({ status: "pending" })
          .where(and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)));

        const slots = await getAvailableSlots({
          serviceId: service.id,
          staffUserId: staff.id,
          date,
          timezone: staff.timezone,
        });
        if (!slots.includes(newStart.toISOString())) {
          throw new HttpError(409, "Selected slot is not available");
        }

        const newEnd = new Date(newStart.getTime() + service.durationMinutes * 60_000);

        const result = await tx
          .update(bookings)
          .set({
            startAt: newStart,
            endAt: newEnd,
            status: "confirmed",
            reminder24hSentAt: null,
            reminder1hSentAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)))
          .returning();
        updated = result[0];
      });
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") throw new HttpError(409, "Slot just taken — pick another");
      throw e;
    }

    if (!updated) throw new HttpError(500, "Reschedule failed");

    // External calendar sync — patch the existing event with the new
    // start/end. Best-effort: a failed sync never fails the request,
    // and the orchestrator no-ops if there's no active connection or
    // no external event id on the booking.
    try {
      await onBookingRescheduled({ booking: updated, staff, serviceName: service.name });
    } catch (gErr) {
      console.error("Calendar sync reschedule failed (booking kept):", gErr);
    }

    // Best-effort email — never fails the request. The reschedule
    // itself already committed above.
    try {
      const gate = await gateSchedulingEmail({
        tenantId: updated.tenantId,
        email: updated.clientEmail,
        kind: "appointment_rescheduled",
      });
      if (!gate.allowed) {
        logSuppressed({
          kind: "appointment_rescheduled",
          reason: gate.reason,
          tenantId: updated.tenantId,
          email: updated.clientEmail,
          bookingId: updated.id,
        });
      } else {
        const tenant = await db.query.tenants.findFirst({
          where: eq(tenants.id, updated.tenantId),
        });
        const [cancelToken, rescheduleToken] = await Promise.all([
          signBookingToken({ bookingId: updated.id, tenantId: updated.tenantId, kind: "cancel" }),
          signBookingToken({ bookingId: updated.id, tenantId: updated.tenantId, kind: "reschedule" }),
        ]);
        const payload: BookingForEmail = {
          id: updated.id,
          serviceName: service.name,
          staffName: staff.name,
          staffEmail: staff.email,
          startAt: updated.startAt,
          endAt: updated.endAt,
          clientName: updated.clientName,
          clientEmail: updated.clientEmail,
          clientTimezone: staff.timezone,
          meetLink: updated.meetLink,
          tenantName: tenant?.name ?? "",
          cancelToken,
          rescheduleToken,
        };
        const tpl = renderReschedule(payload);
        await sendEmail({ to: updated.clientEmail, ...tpl });
      }
    } catch (e) {
      console.error("Reschedule email failed:", e);
    }

    audit({
      tenantId: caller.tenantId,
      action: "booking.reschedule",
      entityType: "booking",
      entityId: updated.id,
      actorUserId: caller.id,
      actorLabel: caller.name,
      metadata: { newStartAt: updated.startAt.toISOString() },
    });

    if (updated.staffUserId !== caller.id) {
      notify({
        tenantId: caller.tenantId,
        userId: updated.staffUserId,
        kind: "booking.rescheduled",
        title: `Booking moved: ${updated.clientName}`,
        body: `New time: ${updated.startAt.toISOString()}`,
        link: "/dashboard/appointments",
        metadata: { bookingId: updated.id },
      });
    }

    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
