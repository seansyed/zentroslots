import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, customers, services, users } from "@/db/schema";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(["active", "vip", "archived"]).optional(),
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
      .where(and(eq(bookings.tenantId, caller.tenantId), eq(bookings.customerId, id)))
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
