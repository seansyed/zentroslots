import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  try {
    const caller = await requireUser();
    const onlyUnread = req.nextUrl.searchParams.get("unread") === "1";
    const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "50")));

    const conds = [
      eq(notifications.tenantId, caller.tenantId),
      eq(notifications.userId, caller.id),
    ];
    if (onlyUnread) conds.push(isNull(notifications.readAt));

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conds))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

// PATCH /api/notifications → mark all read for caller.
export async function PATCH(_req: NextRequest) {
  try {
    const caller = await requireUser();
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.tenantId, caller.tenantId),
          eq(notifications.userId, caller.id),
          isNull(notifications.readAt)
        )
      );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
