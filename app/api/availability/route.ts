import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { availability, users } from "@/db/schema";
import { errorResponse, requireUser, HttpError } from "@/lib/auth";
import { availabilityPutSchema } from "@/lib/validation";

async function resolveTargetUserId(
  reqUrl: URL,
  caller: { id: string; role: string; tenantId: string }
): Promise<string> {
  const targetUserId = reqUrl.searchParams.get("userId") ?? caller.id;

  if (targetUserId === caller.id) return caller.id;

  // Non-self read/write — must be admin in the same tenant as target.
  if (caller.role !== "admin") {
    throw new HttpError(403, "Forbidden");
  }
  const target = await db.query.users.findFirst({
    where: and(eq(users.id, targetUserId), eq(users.tenantId, caller.tenantId)),
  });
  if (!target) throw new HttpError(404, "User not found in workspace");
  return target.id;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser();
    const targetUserId = await resolveTargetUserId(req.nextUrl, user);

    const rules = await db
      .select()
      .from(availability)
      .where(
        and(
          eq(availability.userId, targetUserId),
          eq(availability.tenantId, user.tenantId)
        )
      );

    return NextResponse.json(rules);
  } catch (err) {
    return errorResponse(err);
  }
}

// Replace the entire weekly schedule for the target user.
export async function PUT(req: NextRequest) {
  try {
    const user = await requireUser();
    const targetUserId = await resolveTargetUserId(req.nextUrl, user);

    const body = availabilityPutSchema.parse(await req.json());

    await db.transaction(async (tx) => {
      await tx
        .delete(availability)
        .where(
          and(
            eq(availability.userId, targetUserId),
            eq(availability.tenantId, user.tenantId)
          )
        );
      if (body.rules.length > 0) {
        await tx.insert(availability).values(
          body.rules.map((r) => ({
            tenantId: user.tenantId,
            userId: targetUserId,
            dayOfWeek: r.dayOfWeek,
            startTime: r.startTime,
            endTime: r.endTime,
          }))
        );
      }
    });

    return NextResponse.json({ ok: true, count: body.rules.length });
  } catch (err) {
    return errorResponse(err);
  }
}
