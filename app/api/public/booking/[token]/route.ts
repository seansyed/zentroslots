import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { verifyBookingToken } from "@/lib/tokens";

// Public read of a booking via signed token. Used by /cancel and
// /reschedule pages to render details without a session.
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const payload = await verifyBookingToken(token);
    if (!payload) throw new HttpError(401, "Invalid or expired link");

    const booking = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.id, payload.bookingId),
        eq(bookings.tenantId, payload.tenantId)
      ),
    });
    if (!booking) throw new HttpError(404, "Booking not found");

    const [service, staff, tenant] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, booking.serviceId) }),
      db.query.users.findFirst({ where: eq(users.id, booking.staffUserId) }),
      db.query.tenants.findFirst({ where: eq(tenants.id, booking.tenantId) }),
    ]);

    return NextResponse.json({
      booking: {
        id: booking.id,
        startAt: booking.startAt,
        endAt: booking.endAt,
        status: booking.status,
        clientName: booking.clientName,
        clientEmail: booking.clientEmail,
        meetLink: booking.meetLink,
      },
      service: service && {
        id: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
      },
      staff: staff && {
        id: staff.id,
        name: staff.name,
        timezone: staff.timezone,
      },
      tenant: tenant && { name: tenant.name, slug: tenant.slug },
      kind: payload.kind,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
