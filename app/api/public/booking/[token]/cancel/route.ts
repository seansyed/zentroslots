import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { isFeatureEnabled } from "@/lib/features";
import { onBookingCancelled } from "@/lib/calendar/sync";
import { releaseSlot } from "@/lib/waitlists/releaseSlot";
import { notifySlotAvailable } from "@/lib/waitlists/notifications";
import { verifyBookingToken } from "@/lib/tokens";
import { triggerAutomation } from "@/lib/communications/engine";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const payload = await verifyBookingToken(token);
    if (!payload || payload.kind !== "cancel") {
      throw new HttpError(401, "Invalid or expired link");
    }

    // F30 — optional cancellation reason capture. Best-effort body
    // parse; pre-Wave-4 clients post no body, which is still valid.
    // The reason is trimmed + capped at 1000 chars to keep the column
    // a sensible size and prevent paste-attacks.
    let cancellationReason: string | null = null;
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const body = (await req.json()) as { reason?: unknown };
        if (typeof body?.reason === "string") {
          const trimmed = body.reason.trim().slice(0, 1000);
          if (trimmed.length > 0) cancellationReason = trimmed;
        }
      }
    } catch {
      /* swallow — empty body is fine */
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
      .set({
        status: "cancelled",
        // F30 — only overwrite when a reason was actually provided.
        ...(cancellationReason !== null ? { cancellationReason } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, payload.bookingId),
          eq(bookings.tenantId, payload.tenantId)
        )
      )
      .returning();

    // External calendar sync — delete the event from staff's calendar.
    // Best-effort; no-op without an active connection. 404 from
    // provider treated as success (idempotent).
    try {
      const staffUser = await db.query.users.findFirst({
        where: eq(users.id, updated.staffUserId),
      });
      if (staffUser) {
        await onBookingCancelled({ booking: updated, staff: staffUser });
      }
    } catch (gErr) {
      console.error("Public calendar sync cancel failed (booking kept):", gErr);
    }

    // Waitlist slot-release — best effort. Rule #13: never affects cancel.
    try {
      const release = await releaseSlot({
        tenantId: updated.tenantId,
        serviceId: updated.serviceId,
        staffUserId: updated.staffUserId,
        slotStartAt: updated.startAt,
        slotEndAt: updated.endAt,
        originatingBookingId: updated.id,
      });
      if (release.ok) {
        const staffUser = await db.query.users.findFirst({
          where: eq(users.id, updated.staffUserId),
        });
        await notifySlotAvailable({
          tenantId: updated.tenantId,
          bookingId: updated.id,
          customerEmail: release.customerEmail,
          claimUrl: release.claimUrl,
          expiresAt: release.expiresAt,
          staffTimezone: staffUser?.timezone ?? "UTC",
        });
      }
    } catch (wlErr) {
      console.error("Public waitlist release failed (cancel kept):", wlErr);
    }

    // Best-effort cancellation email via the engine (pref gate + idempotency +
    // METHOD:CANCEL ICS) — never fails the request; the cancellation already
    // landed above. No dedupeKey: one cancel per booking + terminal-state
    // early return upstream make the standard dedup correct.
    try {
      await triggerAutomation({
        tenantId: updated.tenantId,
        bookingId: updated.id,
        eventType: "appointment.cancelled",
        attachIcs: true,
      });
    } catch (e) {
      console.error("Public cancel automation failed:", e);
    }

    return NextResponse.json({ ok: true, status: "cancelled" });
  } catch (err) {
    return errorResponse(err);
  }
}
