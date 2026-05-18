import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { verifyBookingToken } from "@/lib/tokens";
import { renderCancellation, sendEmail, type BookingForEmail } from "@/lib/email";
import { gateSchedulingEmail, logSuppressed } from "@/lib/communications/preferences";

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const payload = await verifyBookingToken(token);
    if (!payload || payload.kind !== "cancel") {
      throw new HttpError(401, "Invalid or expired link");
    }

    // Tenant feature gate. Token may be valid, but the workspace may
    // have disabled customer-initiated cancellations since issuing it.
    if (!(await isFeatureEnabled(payload.tenantId, "cancellations"))) {
      throw new HttpError(403, "Cancellations are no longer available for this booking");
    }

    const booking = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.id, payload.bookingId),
        eq(bookings.tenantId, payload.tenantId)
      ),
    });
    if (!booking) throw new HttpError(404, "Booking not found");

    if (booking.status === "cancelled" || booking.status === "completed") {
      return NextResponse.json({ ok: true, status: booking.status });
    }

    const [updated] = await db
      .update(bookings)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(bookings.id, payload.bookingId),
          eq(bookings.tenantId, payload.tenantId)
        )
      )
      .returning();

    // Best-effort email — never fails the request. The cancellation
    // itself already landed above; the gate just decides whether the
    // courtesy confirmation hits the customer's inbox.
    try {
      const gate = await gateSchedulingEmail({
        tenantId: updated.tenantId,
        email: updated.clientEmail,
        kind: "appointment_cancelled",
      });
      if (!gate.allowed) {
        logSuppressed({
          kind: "appointment_cancelled",
          reason: gate.reason,
          tenantId: updated.tenantId,
          email: updated.clientEmail,
          bookingId: updated.id,
        });
      } else {
        const [svc, staff, tenant] = await Promise.all([
          db.query.services.findFirst({ where: eq(services.id, updated.serviceId) }),
          db.query.users.findFirst({ where: eq(users.id, updated.staffUserId) }),
          db.query.tenants.findFirst({ where: eq(tenants.id, updated.tenantId) }),
        ]);
        if (svc && staff && tenant) {
          const ep: BookingForEmail = {
            id: updated.id,
            serviceName: svc.name,
            staffName: staff.name,
            staffEmail: staff.email,
            startAt: updated.startAt,
            endAt: updated.endAt,
            clientName: updated.clientName,
            clientEmail: updated.clientEmail,
            clientTimezone: staff.timezone,
            meetLink: updated.meetLink,
            tenantName: tenant.name,
          };
          const tpl = renderCancellation(ep);
          await sendEmail({ to: updated.clientEmail, ...tpl });
        }
      }
    } catch (e) {
      console.error("Public cancel email failed:", e);
    }

    return NextResponse.json({ ok: true, status: "cancelled" });
  } catch (err) {
    return errorResponse(err);
  }
}
