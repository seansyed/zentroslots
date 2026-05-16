import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { intakeForms } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { intakeFormSchema } from "@/lib/intake";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireRole(["admin"]);
    const { id } = await context.params;
    const body = intakeFormSchema.partial().parse(await req.json());

    const existing = await db.query.intakeForms.findFirst({
      where: and(eq(intakeForms.id, id), eq(intakeForms.tenantId, admin.tenantId)),
    });
    if (!existing) throw new HttpError(404, "Form not found");

    const [row] = await db
      .update(intakeForms)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(intakeForms.id, id), eq(intakeForms.tenantId, admin.tenantId)))
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
    const admin = await requireRole(["admin"]);
    const { id } = await context.params;
    await db
      .delete(intakeForms)
      .where(and(eq(intakeForms.id, id), eq(intakeForms.tenantId, admin.tenantId)));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
