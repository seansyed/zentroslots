import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, customers, tenants } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { getClientSession } from "@/lib/client-auth";

/**
 * POST /api/client/[slug]/bookings/[bookingId]/feedback
 * Body: { rating: 1-5, note?: string }
 *
 * Authorization chain — same as the ICS route:
 *   1. Tenant slug → tenant exists + active
 *   2. Client session cookie → present + tenantId matches this tenant
 *   3. Booking exists for THIS tenant AND its clientEmail matches the
 *      authenticated customer's email (case-insensitive)
 *
 * Additional business rules:
 *   • Only `completed` bookings accept feedback (400 otherwise)
 *   • Idempotent: re-submitting on a booking that already has feedback
 *     returns 200 `{ ok: true, alreadyRecorded: true }` without
 *     mutating the existing rating
 *   • `note` is trimmed + capped at 2000 chars
 *
 * Any auth failure returns 404 (no enumeration). Business-rule
 * failures return 400 with a descriptive error.
 */

const bodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  note: z.string().optional(),
});

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ slug: string; bookingId: string }> },
) {
  try {
    const { slug, bookingId } = await context.params;
    const notFound = () =>
      new NextResponse(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
    if (!tenant || !tenant.active) return notFound();

    const session = await getClientSession();
    if (!session || session.tenantId !== tenant.id) return notFound();

    const customer = await db.query.customers.findFirst({
      where: and(eq(customers.id, session.customerId), eq(customers.tenantId, tenant.id)),
      columns: { email: true },
    });
    if (!customer) return notFound();

    const body = bodySchema.parse(await req.json());

    const booking = await db.query.bookings.findFirst({
      where: and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenant.id)),
      columns: {
        id: true,
        clientEmail: true,
        status: true,
        feedbackSubmittedAt: true,
      },
    });
    if (!booking) return notFound();
    if (booking.clientEmail.toLowerCase() !== customer.email.toLowerCase()) return notFound();

    if (booking.status !== "completed") {
      throw new HttpError(400, "Feedback is only available for completed appointments.");
    }

    if (booking.feedbackSubmittedAt) {
      return NextResponse.json({ ok: true, alreadyRecorded: true });
    }

    const noteTrimmed = (body.note ?? "").trim().slice(0, 2000) || null;

    await db
      .update(bookings)
      .set({
        feedbackRating: body.rating,
        feedbackNote: noteTrimmed,
        feedbackSubmittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenant.id)));

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
