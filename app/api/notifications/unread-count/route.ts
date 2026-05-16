import { NextResponse } from "next/server";
import { and, count, eq, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { errorResponse, getSession } from "@/lib/auth";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      // Anonymous polling shouldn't error; just return 0.
      return NextResponse.json({ count: 0 });
    }
    const [row] = await db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.tenantId, session.tenantId),
          eq(notifications.userId, session.sub),
          isNull(notifications.readAt)
        )
      );
    return NextResponse.json({ count: Number(row?.n ?? 0) });
  } catch (err) {
    return errorResponse(err);
  }
}
