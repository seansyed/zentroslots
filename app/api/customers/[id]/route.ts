import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, customers, services, users } from "@/db/schema";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  // "prospect" added in Phase 6C — pre-customer relationship tier
  // for nurture / outreach flows. DB column is varchar(40) so this
  // string fits without a schema change.
  status: z.enum(["active", "vip", "archived", "prospect"]).optional(),
  // Free-form labels: dedup + lowercase happens server-side so the UI
  // doesn't have to. Cap arbitrary count for safety.
  tags: z.array(z.string().min(1).max(40)).max(50).optional(),
});

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;

    const customer = await db.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.tenantId, caller.tenantId)),
    });
    if (!customer) throw new HttpError(404, "Customer not found");

    // Booking history match — two channels in priority order:
    //   1. Linked: bookings.customer_id = this customer's id
    //   2. Email fallback: bookings with NO customer_id but whose
    //      client_email matches this customer's email. These are
    //      orphans from public-booking flows where upsertCustomer
    //      either hadn't been added yet or silently failed during the
    //      best-effort post-create chain. Adding them here makes the
    //      timeline trustworthy without a backfill migration.
    //
    // We keep `customer_id IS NULL` on the fallback so we never steal
    // bookings that DO have an explicit (different) customer link —
    // important if a single email is reused across multiple records.
    const customerEmail = (customer.email ?? "").trim().toLowerCase();
    const history = await db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        status: bookings.status,
        meetLink: bookings.meetLink,
        notes: bookings.notes,
        serviceName: services.name,
        staffName: users.name,
      })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .innerJoin(users, eq(users.id, bookings.staffUserId))
      .where(
        and(
          eq(bookings.tenantId, caller.tenantId),
          customerEmail
            ? or(
                eq(bookings.customerId, id),
                and(
                  isNull(bookings.customerId),
                  sql`lower(${bookings.clientEmail}) = ${customerEmail}`,
                ),
              )
            : eq(bookings.customerId, id),
        ),
      )
      .orderBy(desc(bookings.startAt))
      .limit(100);

    return NextResponse.json({ customer, history });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());

    const existing = await db.query.customers.findFirst({
      where: and(eq(customers.id, id), eq(customers.tenantId, caller.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Customer not found");

    // Normalize tags: trim, lowercase, dedup, drop empty.
    const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.tags) {
      const seen = new Set<string>();
      patch.tags = body.tags
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t && !seen.has(t) && (seen.add(t), true));
    }

    const [row] = await db
      .update(customers)
      .set(patch)
      .where(and(eq(customers.id, id), eq(customers.tenantId, caller.tenantId)))
      .returning();
    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}
