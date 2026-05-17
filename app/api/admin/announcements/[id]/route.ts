import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { announcements } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    const [row] = await db
      .delete(announcements)
      .where(eq(announcements.id, id))
      .returning();
    if (!row) throw new HttpError(404, "Announcement not found");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
