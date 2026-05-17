import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gte } from "drizzle-orm";

import { db } from "@/db/client";
import { availabilityOverrides, users } from "@/db/schema";
import { errorResponse, isManagerial, requireUser, HttpError } from "@/lib/auth";
import { overrideCreateSchema } from "@/lib/validation";
import type { Role } from "@/db/schema";

async function resolveTargetUserId(
  bodyOrQueryUserId: string | undefined,
  caller: { id: string; role: Role; tenantId: string }
): Promise<string> {
  const target = bodyOrQueryUserId ?? caller.id;
  if (target === caller.id) return caller.id;
  // Managers may edit any staff member's overrides in their workspace.
  if (!isManagerial(caller.role)) throw new HttpError(403, "Forbidden");
  const exists = await db.query.users.findFirst({
    where: and(eq(users.id, target), eq(users.tenantId, caller.tenantId)),
  });
  if (!exists) throw new HttpError(404, "User not found in workspace");
  return exists.id;
}

export async function GET(req: NextRequest) {
  try {
    const caller = await requireUser();
    const targetUserId = await resolveTargetUserId(
      req.nextUrl.searchParams.get("userId") ?? undefined,
      caller
    );

    // Default: future-only (and today). ?all=1 returns everything for the user.
    const all = req.nextUrl.searchParams.get("all") === "1";
    const today = new Date().toISOString().slice(0, 10);

    const conds = [
      eq(availabilityOverrides.tenantId, caller.tenantId),
      eq(availabilityOverrides.userId, targetUserId),
    ];
    if (!all) conds.push(gte(availabilityOverrides.date, today));

    const rows = await db
      .select()
      .from(availabilityOverrides)
      .where(and(...conds))
      .orderBy(asc(availabilityOverrides.date));

    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const caller = await requireUser();
    const body = overrideCreateSchema.parse(await req.json());
    const targetUserId = await resolveTargetUserId(body.userId, caller);

    const [row] = await db
      .insert(availabilityOverrides)
      .values({
        tenantId: caller.tenantId,
        userId: targetUserId,
        date: body.date,
        unavailable: body.unavailable,
        startTime: body.unavailable ? null : body.startTime!,
        endTime: body.unavailable ? null : body.endTime!,
        reason: body.reason,
      })
      .returning();

    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
