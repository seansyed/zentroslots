import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(["open", "done"]).optional(),
  priority: z.enum(["urgent", "high", "medium", "low"]).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());

    const existing = await db.query.tasks.findFirst({
      where: and(eq(tasks.id, id), eq(tasks.tenantId, caller.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Task not found");

    const updates: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.status === "done" && !existing.completedAt) updates.completedAt = new Date();
    if (body.status === "open") updates.completedAt = null;
    if (body.dueAt !== undefined) updates.dueAt = body.dueAt ? new Date(body.dueAt) : null;

    const [row] = await db
      .update(tasks)
      .set(updates)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, caller.tenantId)))
      .returning();
    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    await db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, caller.tenantId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
