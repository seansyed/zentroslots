import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { deleteCustomHostname } from "@/lib/cloudflare-hostnames";
import { invalidateHostnameCache } from "@/lib/domains";

/**
 * DELETE /api/tenant/domains/[id]
 *
 * Two-stage cleanup, in this order:
 *   1. Tear down the Cloudflare Custom Hostname (best-effort — a CF
 *      failure does NOT block the local delete; the background sync
 *      worker reconciles orphans on its next pass).
 *   2. Delete the local row + invalidate the hostname cache so the
 *      next inbound request to that host falls back to canonical.
 *
 * Audit log is written on success.
 */
export async function DELETE(
  req: Request,
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

    // 1) Cloudflare cleanup — only attempted when we have a CF id.
    //    Failures are surfaced in the audit log but don't block.
    let cfCleanupError: string | null = null;
    if (row.cfHostnameId) {
      const r = await deleteCustomHostname(row.cfHostnameId);
      if (!r.ok && r.status !== 503) {
        cfCleanupError = r.message;
      }
    }

    // 2) Local delete + cache invalidate
    await db.delete(tenantDomains).where(eq(tenantDomains.id, row.id));
    invalidateHostnameCache(row.normalizedHost);

    await audit({
      tenantId: admin.tenantId,
      action: "domain.removed",
      actorUserId: admin.id,
      entityType: "tenant_domain",
      entityId: row.id,
      ipAddress: ipFromHeaders(req.headers),
      metadata: {
        host: row.normalizedHost,
        cf_hostname_id: row.cfHostnameId,
        cf_cleanup_error: cfCleanupError ?? undefined,
      },
    });

    return NextResponse.json({ ok: true, id: row.id });
  } catch (err) {
    return errorResponse(err);
  }
}
