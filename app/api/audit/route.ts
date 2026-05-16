import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { auditLogs } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";

export async function GET(req: NextRequest) {
  try {
    const caller = await requireUser();
    const entityId = req.nextUrl.searchParams.get("entityId");
    const entityType = req.nextUrl.searchParams.get("entityType");
    const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? "30")));

    const conds = [eq(auditLogs.tenantId, caller.tenantId)];
    if (entityId) conds.push(eq(auditLogs.entityId, entityId));
    if (entityType) conds.push(eq(auditLogs.entityType, entityType));

    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actorLabel: auditLogs.actorLabel,
        actorUserId: auditLogs.actorUserId,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(...conds))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);

    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
