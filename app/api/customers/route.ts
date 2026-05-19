import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { bookings, customers } from "@/db/schema";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";

const STATUS_VALUES = ["active", "vip", "archived", "prospect"] as const;

const createSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().max(40).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(STATUS_VALUES).optional(),
  tags: z.array(z.string().min(1).max(40)).max(50).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const caller = await requireUser();
    const search = (req.nextUrl.searchParams.get("q") ?? "").trim();

    const conds = [eq(customers.tenantId, caller.tenantId)];
    if (search) {
      conds.push(or(ilike(customers.name, `%${search}%`), ilike(customers.email, `%${search}%`))!);
    }

    const rows = await db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        status: customers.status,
        tags: customers.tags,
        createdAt: customers.createdAt,
      })
      .from(customers)
      .where(and(...conds))
      .orderBy(asc(customers.name))
      .limit(200);

    // Aggregate booking stats per customer.
    const stats = await db
      .select({
        customerId: bookings.customerId,
        total: sql<number>`COUNT(*)::int`,
        cancelled: sql<number>`SUM(CASE WHEN ${bookings.status} = 'cancelled' THEN 1 ELSE 0 END)::int`,
        completed: sql<number>`SUM(CASE WHEN ${bookings.status} = 'completed' THEN 1 ELSE 0 END)::int`,
        lastAt: sql<Date | null>`MAX(${bookings.startAt})`,
      })
      .from(bookings)
      .where(eq(bookings.tenantId, caller.tenantId))
      .groupBy(bookings.customerId);

    const byCustomer = new Map(stats.map((s) => [s.customerId, s]));

    return NextResponse.json(
      rows.map((r) => {
        const s = byCustomer.get(r.id);
        return {
          ...r,
          totalBookings: Number(s?.total ?? 0),
          cancelled: Number(s?.cancelled ?? 0),
          completed: Number(s?.completed ?? 0),
          lastAppointmentAt: s?.lastAt ? new Date(s.lastAt as unknown as string).toISOString() : null,
        };
      })
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const caller = await requireUser();
    const body = createSchema.parse(await req.json());

    // Reuse if email already exists in this tenant.
    const existing = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        sql`${customers.tenantId} = ${caller.tenantId} AND lower(${customers.email}) = lower(${body.email})`
      )
      .limit(1);
    if (existing[0]) {
      throw new HttpError(409, "A customer with this email already exists");
    }

    // Normalize tags: trim, lowercase, dedup, drop empty.
    let normalizedTags: string[] | undefined = undefined;
    if (body.tags) {
      const seen = new Set<string>();
      normalizedTags = body.tags
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t && !seen.has(t) && (seen.add(t), true));
    }

    const [row] = await db
      .insert(customers)
      .values({
        tenantId: caller.tenantId,
        name: body.name,
        email: body.email,
        phone: body.phone ?? null,
        notes: body.notes ?? null,
        ...(body.status ? { status: body.status } : {}),
        ...(normalizedTags ? { tags: normalizedTags } : {}),
      })
      .returning();

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
