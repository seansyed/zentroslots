/**
 * Wave I — admin read of submitted intake responses for a booking.
 *
 *   GET /api/bookings/<id>/intake-responses
 *
 * Reads from the NEW normalized intake_field_responses table. Falls
 * back to bookings.intake_responses jsonb for pre-Wave-I bookings.
 * Tenant-scoped via session.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, intakeFieldResponses } from "@/db/schema";
import { errorResponse, HttpError, isManagerial, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");

    const booking = await db.query.bookings.findFirst({
      where: and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)),
      columns: {
        id: true,
        staffUserId: true,
        intakeResponses: true,
      },
    });
    if (!booking) throw new HttpError(404, "Not found");
    // Staff role: only their own bookings.
    if (!isManagerial(caller.role) && booking.staffUserId !== caller.id) {
      throw new HttpError(403, "Forbidden");
    }

    // Prefer normalized rows. Falls back to legacy jsonb when none exist.
    const rows = await db
      .select({
        fieldKey: intakeFieldResponses.fieldKey,
        fieldLabel: intakeFieldResponses.fieldLabel,
        fieldType: intakeFieldResponses.fieldType,
        valueText: intakeFieldResponses.valueText,
        valueNumber: intakeFieldResponses.valueNumber,
        valueJson: intakeFieldResponses.valueJson,
        createdAt: intakeFieldResponses.createdAt,
      })
      .from(intakeFieldResponses)
      .where(
        and(
          eq(intakeFieldResponses.bookingId, id),
          eq(intakeFieldResponses.tenantId, caller.tenantId),
        ),
      )
      .orderBy(asc(intakeFieldResponses.createdAt));

    if (rows.length > 0) {
      return NextResponse.json({
        source: "normalized",
        responses: rows.map((r) => ({
          fieldKey: r.fieldKey,
          fieldLabel: r.fieldLabel,
          fieldType: r.fieldType,
          value:
            r.valueJson !== null && r.valueJson !== undefined
              ? r.valueJson
              : r.valueNumber !== null
              ? Number(r.valueNumber)
              : r.valueText,
        })),
      });
    }

    // Legacy fallback. Shape: Record<fieldKey, value>.
    const legacy = (booking.intakeResponses as Record<string, unknown> | null) ?? {};
    return NextResponse.json({
      source: "legacy",
      responses: Object.entries(legacy).map(([key, value]) => ({
        fieldKey: key,
        fieldLabel: key,
        fieldType: typeof value === "object" ? "multi_select" : "short_text",
        value,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
