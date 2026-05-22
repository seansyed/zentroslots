import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, customers, tenants } from "@/db/schema";
import { errorResponse } from "@/lib/auth";
import { getClientSession } from "@/lib/client-auth";
import { performReschedule } from "@/lib/reschedule";

/**
 * POST /api/client/[slug]/bookings/[bookingId]/reschedule
 * Body: { startAt: ISO-8601 string }
 *
 * Portal-authenticated reschedule. Same engine + same side effects as
 * the public token route (`lib/reschedule.performReschedule`) — just
 * a different authorization chain:
 *
 *   1. Tenant slug → row exists + active
 *   2. Client session cookie → present + tenantId matches this tenant
 *   3. Booking exists for THIS tenant AND its clientEmail matches the
 *      authenticated customer's email (case-insensitive)
 *
 * Any auth failure returns 404 (no enumeration). Engine failures
 * (slot conflict, terminal state, feature disabled) map to 4xx with
 * a descriptive error.
 */

const bodySchema = z.object({
  startAt: z.string().min(1),
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

    // Booking ownership — same email-equality rule used everywhere
    // else in the portal. Done before the engine is called so the
    // helper never has to know about portal auth.
    const booking = await db.query.bookings.findFirst({
      where: and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenant.id)),
      columns: { id: true, clientEmail: true },
    });
    if (!booking) return notFound();
    if (booking.clientEmail.toLowerCase() !== customer.email.toLowerCase()) {
      return notFound();
    }

    const body = bodySchema.parse(await req.json());

    const result = await performReschedule({
      bookingId,
      tenantId: tenant.id,
      newStartIso: body.startAt,
      source: "portal",
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, status: "confirmed" });
  } catch (err) {
    return errorResponse(err);
  }
}
