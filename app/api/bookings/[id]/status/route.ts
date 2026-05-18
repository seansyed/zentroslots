import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";
import { errorResponse, isManagerial, requireUser, HttpError } from "@/lib/auth";
import { bookingStatusSchema } from "@/lib/validation";
import { onBookingTerminalReviewRequest } from "@/lib/automations/reviewRequests";
import { onBookingTerminalFollowups } from "@/lib/automations/followups";
import type { FollowupTriggerEvent } from "@/lib/automations/types";

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

    // Post-flip automations — review requests + follow-ups. Best-effort:
    // never affects the status update (rule #13). Cancellations don't
    // fire from here (the dedicated /cancel route handles that flow).
    if (updated.status === "completed" || updated.status === "no_show") {
      try {
        // Review requests only fire on a terminal state where the
        // rule's suppression flags allow it. The orchestrator handles
        // all the suppression logic — we just hand it the status.
        await onBookingTerminalReviewRequest({
          tenantId: caller.tenantId,
          serviceId: updated.serviceId,
          bookingId: updated.id,
          status: updated.status as "completed" | "no_show",
        });
      } catch (autoErr) {
        console.error("Review-request automation failed (status update kept):", autoErr);
      }
      try {
        // Follow-ups dispatched by trigger_event. The status flip maps
        // 1:1 to a trigger event string.
        const triggerEvent: FollowupTriggerEvent =
          updated.status === "completed"
            ? "appointment.completed"
            : "appointment.no_show";
        await onBookingTerminalFollowups({
          tenantId: caller.tenantId,
          serviceId: updated.serviceId,
          bookingId: updated.id,
          triggerEvent,
        });
      } catch (autoErr) {
        console.error("Followup automations failed (status update kept):", autoErr);
      }
    }

    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
