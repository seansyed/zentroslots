import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { promotions } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

const patchInput = z.object({ active: z.boolean() });

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    const body = patchInput.parse(await req.json());
    const [row] = await db
      .update(promotions)
      .set({ active: body.active })
      .where(eq(promotions.id, id))
      .returning();
    if (!row) throw new HttpError(404, "Promotion not found");
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
    await requireSuperAdmin();
    const { id } = await context.params;
    const [row] = await db
      .delete(promotions)
      .where(eq(promotions.id, id))
      .returning();
    if (!row) throw new HttpError(404, "Promotion not found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
