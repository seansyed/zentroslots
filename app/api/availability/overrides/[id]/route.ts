import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { availabilityOverrides } from "@/db/schema";
import { errorResponse, isManagerial, requireUser, HttpError } from "@/lib/auth";

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;

    // Fetch tenant-scoped, also enforce ownership: caller's own row OR admin in tenant.
    const row = await db.query.availabilityOverrides.findFirst({
      where: and(
        eq(availabilityOverrides.id, id),
        eq(availabilityOverrides.tenantId, caller.tenantId)
      ),
    });
    if (!row) throw new HttpError(404, "Override not found");
    if (row.userId !== caller.id && !isManagerial(caller.role)) {
      throw new HttpError(403, "Forbidden");
    }

    await db
      .delete(availabilityOverrides)
      .where(
        and(
          eq(availabilityOverrides.id, id),
          eq(availabilityOverrides.tenantId, caller.tenantId)
        )
      );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
