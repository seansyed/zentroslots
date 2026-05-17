import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";
import { errorResponse, isManagerial, requireUser, HttpError } from "@/lib/auth";
import { bookingStatusSchema } from "@/lib/validation";

// Used to mark completed / no_show / re-confirm. Tenant + role gated.
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    const body = bookingStatusSchema.parse(await req.json());

    const booking = await db.query.bookings.findFirst({
      where: and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)),
    });
    if (!booking) throw new HttpError(404, "Booking not found");
    if (!isManagerial(caller.role) && booking.staffUserId !== caller.id) {
      throw new HttpError(403, "Forbidden");
    }

    // Transitioning back to confirmed could conflict with another confirmed
    // booking on the same staff/time — the EXCLUDE constraint will reject it
    // and we surface 409.
    let updated;
    try {
      [updated] = await db
        .update(bookings)
        .set({ status: body.status, updatedAt: new Date() })
        .where(and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)))
        .returning();
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") throw new HttpError(409, "Status change conflicts with another booking");
      throw e;
    }

    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
