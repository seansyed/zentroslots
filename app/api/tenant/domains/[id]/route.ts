import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { invalidateHostnameCache } from "@/lib/domains";

/**
 * DELETE /api/tenant/domains/[id]
 *
 * Removes the domain mapping. Idempotent at the contract level — a
 * missing domain returns 404 rather than silently succeeding so the
 * operator gets clear feedback when something's off.
 *
 * After deletion the hostname cache is invalidated immediately so the
 * next request to that host falls back to the canonical-host path.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireRole(["admin"]);
    const { id } = await params;

    const row = await db.query.tenantDomains.findFirst({
      where: and(
        eq(tenantDomains.id, id),
        eq(tenantDomains.tenantId, admin.tenantId),
      ),
    });
    if (!row) throw new HttpError(404, "Domain not found");

    await db.delete(tenantDomains).where(eq(tenantDomains.id, row.id));
    invalidateHostnameCache(row.normalizedHost);

    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    return errorResponse(err);
  }
}
