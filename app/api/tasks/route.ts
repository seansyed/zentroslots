import { NextRequest, NextResponse } from "next/server";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { customers, tasks, users } from "@/db/schema";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";

const PRIORITY_VALUES = ["urgent", "high", "medium", "low"] as const;

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  priority: z.enum(PRIORITY_VALUES).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
  relatedCustomerId: z.string().uuid().nullable().optional(),
  relatedBookingId: z.string().uuid().nullable().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const caller = await requireUser();
    const status = req.nextUrl.searchParams.get("status");
    const mine = req.nextUrl.searchParams.get("mine") === "1";

    const conds = [eq(tasks.tenantId, caller.tenantId)];
    if (status === "open" || status === "done") conds.push(eq(tasks.status, status));
    if (mine) conds.push(eq(tasks.assignedUserId, caller.id));

    const rows = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        priority: tasks.priority,
        dueAt: tasks.dueAt,
        assignedUserId: tasks.assignedUserId,
        relatedCustomerId: tasks.relatedCustomerId,
        relatedBookingId: tasks.relatedBookingId,
        createdAt: tasks.createdAt,
        completedAt: tasks.completedAt,
        assignedName: users.name,
        customerName: customers.name,
      })
      .from(tasks)
      .leftJoin(users, eq(users.id, tasks.assignedUserId))
      .leftJoin(customers, eq(customers.id, tasks.relatedCustomerId))
      .where(and(...conds))
      .orderBy(asc(tasks.status), asc(tasks.dueAt), desc(tasks.createdAt))
      .limit(200);

    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const caller = await requireUser();
    const body = createSchema.parse(await req.json());

    // Validate assigned user is in the same tenant.
    if (body.assignedUserId) {
      const u = await db.query.users.findFirst({
        where: and(eq(users.id, body.assignedUserId), eq(users.tenantId, caller.tenantId)),
      });
      if (!u) throw new HttpError(400, "Assigned user not in workspace");
    }
    if (body.relatedCustomerId) {
      const c = await db.query.customers.findFirst({
        where: and(eq(customers.id, body.relatedCustomerId), eq(customers.tenantId, caller.tenantId)),
      });
      if (!c) throw new HttpError(400, "Customer not in workspace");
    }

    const [row] = await db
      .insert(tasks)
      .values({
        tenantId: caller.tenantId,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? null,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        assignedUserId: body.assignedUserId ?? null,
        relatedCustomerId: body.relatedCustomerId ?? null,
        relatedBookingId: body.relatedBookingId ?? null,
        createdByUserId: caller.id,
      })
      .returning();

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
