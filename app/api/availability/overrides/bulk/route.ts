import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { availabilityOverrides, users } from "@/db/schema";
import { errorResponse, requireUser, HttpError } from "@/lib/auth";
import { overrideBulkSchema } from "@/lib/validation";

export async function POST(req: NextRequest) {
  try {
    const caller = await requireUser();
    const body = overrideBulkSchema.parse(await req.json());

    let targetUserId = body.userId ?? caller.id;
    if (targetUserId !== caller.id) {
      if (caller.role !== "admin") throw new HttpError(403, "Forbidden");
      const exists = await db.query.users.findFirst({
        where: and(eq(users.id, targetUserId), eq(users.tenantId, caller.tenantId)),
      });
      if (!exists) throw new HttpError(404, "User not found in workspace");
      targetUserId = exists.id;
    }

    if (!body.unavailable && (!body.startTime || !body.endTime)) {
      throw new HttpError(400, "startTime + endTime required when unavailable=false");
    }

    const values = body.dates.map((d) => ({
      tenantId: caller.tenantId,
      userId: targetUserId,
      date: d,
      unavailable: body.unavailable,
      startTime: body.unavailable ? null : body.startTime!,
      endTime: body.unavailable ? null : body.endTime!,
      reason: body.reason,
    }));

    const inserted = await db
      .insert(availabilityOverrides)
      .values(values)
      .returning();

    return NextResponse.json({ count: inserted.length, ids: inserted.map((r) => r.id) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
