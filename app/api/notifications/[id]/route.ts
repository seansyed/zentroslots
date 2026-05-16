import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";

// Mark a single notification read (idempotent).
export async function PATCH(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    const row = await db.query.notifications.findFirst({
      where: and(
        eq(notifications.id, id),
        eq(notifications.tenantId, caller.tenantId),
        eq(notifications.userId, caller.id)
      ),
    });
    if (!row) throw new HttpError(404, "Notification not found");
    if (row.readAt) return NextResponse.json(row);

    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, id))
      .returning();
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}
