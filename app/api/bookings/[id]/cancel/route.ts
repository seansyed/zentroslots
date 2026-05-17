import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { errorResponse, isManagerial, requireUser, HttpError } from "@/lib/auth";
import { renderCancellation, sendEmail, type BookingForEmail } from "@/lib/email";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { postTenantWebhook } from "@/lib/outbound";

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;

    const booking = await db.query.bookings.findFirst({
      where: and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)),
    });
    if (!booking) throw new HttpError(404, "Booking not found");

    // Staff can cancel their own; admins + managers can cancel any in tenant.
    if (!isManagerial(caller.role) && booking.staffUserId !== caller.id) {
      throw new HttpError(403, "Forbidden");
    }

    if (booking.status === "cancelled" || booking.status === "completed") {
      return NextResponse.json(booking); // idempotent for terminal states
    }

    const [updated] = await db
      .update(bookings)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)))
      .returning();

    // Best-effort cancellation email — never fails the request.
    try {
      const [svc, staff, tenant] = await Promise.all([
        db.query.services.findFirst({ where: eq(services.id, updated.serviceId) }),
        db.query.users.findFirst({ where: eq(users.id, updated.staffUserId) }),
        db.query.tenants.findFirst({ where: eq(tenants.id, updated.tenantId) }),
      ]);
      if (svc && staff && tenant) {
        const payload: BookingForEmail = {
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
        const tpl = renderCancellation(payload);
        await sendEmail({ to: updated.clientEmail, ...tpl });
      }
    } catch (e) {
      console.error("Cancellation email failed:", e);
    }

    audit({
      tenantId: caller.tenantId,
      action: "booking.cancel",
      entityType: "booking",
      entityId: updated.id,
      actorUserId: caller.id,
      actorLabel: caller.name,
      metadata: { startAt: updated.startAt.toISOString() },
    });

    // Notify the assigned staff member if it wasn't them who cancelled.
    if (updated.staffUserId !== caller.id) {
      notify({
        tenantId: caller.tenantId,
        userId: updated.staffUserId,
        kind: "booking.cancelled",
        title: `Booking cancelled: ${updated.clientName}`,
        body: `Slot on ${updated.startAt.toISOString()} is now free.`,
        link: "/dashboard/appointments",
        metadata: { bookingId: updated.id },
      });
    }

    // Outbound webhook (best-effort, never throws).
    postTenantWebhook({
      tenantId: caller.tenantId,
      text: `❌ Booking cancelled: ${updated.clientName} (${updated.startAt.toISOString()})`,
      metadata: { event: "booking.cancelled", bookingId: updated.id },
    });

    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
