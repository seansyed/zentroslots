import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookingOccurrences,
  bookingSeries,
} from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";

// GET /api/tenant/booking-series/:id
//
// Series detail + all occurrence rows. Tenant-isolated.
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const { id } = await context.params;

    const series = await db.query.bookingSeries.findFirst({
      where: and(eq(bookingSeries.id, id), eq(bookingSeries.tenantId, admin.tenantId)),
    });
    if (!series) throw new HttpError(404, "Series not found");

    const occurrences = await db
      .select()
      .from(bookingOccurrences)
      .where(eq(bookingOccurrences.bookingSeriesId, id))
      .orderBy(asc(bookingOccurrences.occurrenceIndex));

    return NextResponse.json({ series, occurrences });
  } catch (err) {
    return errorResponse(err);
  }
}
