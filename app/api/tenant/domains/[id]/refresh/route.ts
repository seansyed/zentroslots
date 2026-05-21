import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import {
  extractCfErrors,
  mapCfSslStatus,
  refreshHostnameStatus,
} from "@/lib/cloudflare-hostnames";
import { invalidateHostnameCache, serializeDomain } from "@/lib/domains";

/**
 * POST /api/tenant/domains/[id]/refresh
 *
 * Lightweight SSL-state poll. Hits Cloudflare's GET /custom_hostnames/:id
 * and writes back ssl_status + verification_errors. Does NOT re-run
 * DNS verification — that lives in /verify. Used by:
 *   - the UI "Re-check TLS" button when ssl_status is in-flight
 *   - the background sync cron (scripts/sync-domain-ssl.ts)
 *
 * Returns the updated domain row. Safe to call repeatedly.
 */
export async function POST(
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

    if (!row.cfHostnameId) {
      // Nothing to refresh against — return the row as-is so the UI
      // can still show its current state without erroring out.
      return NextResponse.json({ domain: serializeDomain(row), refreshed: false });
    }

    const refreshed = await refreshHostnameStatus(row.cfHostnameId);
    if (!refreshed.ok) {
      // CF unreachable → record the error but don't fail the request.
      const [updated] = await db
        .update(tenantDomains)
        .set({
          verificationErrors: refreshed.message,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tenantDomains.id, row.id))
        .returning();
      return NextResponse.json({
        domain: serializeDomain(updated),
        refreshed: false,
        error: refreshed.message,
      });
    }

    const mapped = mapCfSslStatus(refreshed.result.ssl?.status);
    const verificationErrors = extractCfErrors(refreshed.result);
    const now = new Date();
    const activatedAt =
      mapped.status === "active" && !row.activatedAt ? now : row.activatedAt;

    const [updated] = await db
      .update(tenantDomains)
      .set({
        sslStatus: mapped.status,
        verificationErrors,
        activatedAt,
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(tenantDomains.id, row.id))
      .returning();

    // SSL transitions affect routing freshness — flush the cache so
    // the next request sees the latest state.
    invalidateHostnameCache(row.normalizedHost);

    return NextResponse.json({ domain: serializeDomain(updated), refreshed: true });
  } catch (err) {
    return errorResponse(err);
  }
}
