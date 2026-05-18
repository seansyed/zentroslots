import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { signBookingToken, verifyBookingToken } from "@/lib/tokens";
import { publicRescheduleSchema } from "@/lib/validation";
import { getAvailableSlots } from "@/lib/availability";
import { renderReschedule, sendEmail, type BookingForEmail } from "@/lib/email";
import { gateSchedulingEmail, logSuppressed } from "@/lib/communications/preferences";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const payload = await verifyBookingToken(token);
    if (!payload || payload.kind !== "reschedule") {
      throw new HttpError(401, "Invalid or expired link");
    }

    // Tenant feature gate. Even though the token is valid, the
    // workspace may have disabled customer-initiated rescheduling
    // after the link was issued — refuse here before any state
    // changes.
    if (!(await isFeatureEnabled(payload.tenantId, "rescheduling"))) {
      throw new HttpError(403, "Rescheduling is no longer available for this booking");
    }

    const body = publicRescheduleSchema.parse(await req.json());
    const newStart = new Date(body.startAt);
    if (Number.isNaN(newStart.getTime())) throw new HttpError(400, "Invalid startAt");

    const booking = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.id, payload.bookingId),
        eq(bookings.tenantId, payload.tenantId)
      ),
    });
    if (!booking) throw new HttpError(404, "Booking not found");
    if (booking.status === "cancelled" || booking.status === "completed") {
      throw new HttpError(409, "Booking is in a terminal state");
    }

    const [service, staff] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, booking.serviceId) }),
      db.query.users.findFirst({ where: eq(users.id, booking.staffUserId) }),
    ]);
    if (!service || !staff) throw new HttpError(404, "Service or staff missing");

    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: staff.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(newStart);

    let updated: typeof bookings.$inferSelect | undefined;
    try {
      await db.transaction(async (tx) => {
        // Free the slot the current booking holds so the engine sees it as open.
        await tx
          .update(bookings)
          .set({ status: "pending" })
          .where(
            and(
              eq(bookings.id, payload.bookingId),
              eq(bookings.tenantId, payload.tenantId)
            )
          );

        const slots = await getAvailableSlots({
          serviceId: service.id,
          staffUserId: staff.id,
          date,
          timezone: staff.timezone,
        });
        if (!slots.includes(newStart.toISOString())) {
          throw new HttpError(409, "Slot not available");
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
          .where(
            and(
              eq(bookings.id, payload.bookingId),
              eq(bookings.tenantId, payload.tenantId)
            )
          )
          .returning();
        updated = result[0];
      });
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") throw new HttpError(409, "Slot just taken — pick another");
      throw e;
    }

    if (!updated) throw new HttpError(500, "Reschedule failed");

    // Best-effort email with fresh tokens for the new booking time.
    // The reschedule landed in the DB already — the gate only decides
    // whether the courtesy confirmation hits their inbox.
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
          where: eq(tenants.id, payload.tenantId),
        });
        const [cancelToken, rescheduleToken] = await Promise.all([
          signBookingToken({ bookingId: updated.id, tenantId: updated.tenantId, kind: "cancel" }),
          signBookingToken({ bookingId: updated.id, tenantId: updated.tenantId, kind: "reschedule" }),
        ]);
        const ep: BookingForEmail = {
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
        const tpl = renderReschedule(ep);
        await sendEmail({ to: updated.clientEmail, ...tpl });
      }
    } catch (e) {
      console.error("Public reschedule email failed:", e);
    }

    return NextResponse.json({ ok: true, status: "confirmed" });
  } catch (err) {
    return errorResponse(err);
  }
}
