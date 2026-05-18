import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookingOccurrences, bookingSeries } from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { sanitizeOverride } from "@/lib/recurrence/exceptions";

// PATCH /api/tenant/booking-series/:id/occurrences/:occId
//
// Per-occurrence operations:
//   - { action: "skip" }       → flag this occurrence as skipped
//   - { action: "cancel" }     → mark cancelled (won't materialize)
//   - { action: "override", override: {...} }
//                              → set per-occurrence override (startAt,
//                                 staffUserId, skip, note)
//
// IMPORTANT: This NEVER mutates the series rule. "Edit this and following"
// is deferred. Edits land on the occurrence row only.
//
// If the occurrence has already materialized into a booking
// (booking_id is set), the override doesn't retroactively update the
// booking row — admins should use the booking-level cancel/reschedule
// route for that. We document this and 409 on override attempts after
// materialization.
const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("skip") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("override"), override: z.record(z.unknown()) }),
]);

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string; occId: string }> }
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id, occId } = await context.params;
    const body = patchSchema.parse(await req.json());

    // Tenant + series + occurrence isolation.
    const series = await db.query.bookingSeries.findFirst({
      where: and(eq(bookingSeries.id, id), eq(bookingSeries.tenantId, admin.tenantId)),
    });
    if (!series) throw new HttpError(404, "Series not found");

    const occ = await db.query.bookingOccurrences.findFirst({
      where: and(
        eq(bookingOccurrences.id, occId),
        eq(bookingOccurrences.bookingSeriesId, id),
        eq(bookingOccurrences.tenantId, admin.tenantId)
      ),
    });
    if (!occ) throw new HttpError(404, "Occurrence not found");

    // If already materialized into a booking, override is too late
    // (booking has its own lifecycle now).
    if (occ.bookingId && body.action === "override") {
      throw new HttpError(
        409,
        "Occurrence has already been materialized. Use the booking actions to reschedule or cancel."
      );
    }

    if (body.action === "skip") {
      await db
        .update(bookingOccurrences)
        .set({ status: "skipped", failureReason: "manual_skip", updatedAt: new Date() })
        .where(eq(bookingOccurrences.id, occId));
    } else if (body.action === "cancel") {
      await db
        .update(bookingOccurrences)
        .set({ status: "cancelled", failureReason: "manual_cancel", updatedAt: new Date() })
        .where(eq(bookingOccurrences.id, occId));
    } else {
      const safeOverride = sanitizeOverride(body.override);
      await db
        .update(bookingOccurrences)
        .set({
          overrides: safeOverride,
          updatedAt: new Date(),
        })
        .where(eq(bookingOccurrences.id, occId));
    }

    audit({
      tenantId: admin.tenantId,
      action: `booking_series.occurrence_${body.action}`,
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "booking_occurrence",
      entityId: occId,
      metadata: { seriesId: id, action: body.action },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
