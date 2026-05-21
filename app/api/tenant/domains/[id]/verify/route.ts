import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import {
  dnsInstructions,
  invalidateHostnameCache,
  serializeDomain,
  verifyDomainDns,
} from "@/lib/domains";

/**
 * POST /api/tenant/domains/[id]/verify
 *
 * Re-runs DNS verification against the host's CURRENT records and
 * updates status / ssl_status / last_checked_at / verified_at
 * accordingly. Real DNS resolution via node:dns. No fake success.
 *
 * Idempotent — safe to call repeatedly. UI polls this every few seconds
 * after the user adds a domain.
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

    const outcome = await verifyDomainDns(row.normalizedHost, row.verificationToken);

    // Persist outcome. We always bump last_checked_at + updated_at.
    // verified_at is set on first successful verification, preserved on
    // subsequent ones.
    const verifiedAt =
      outcome.status === "verified"
        ? row.verifiedAt ?? outcome.checkedAt
        : null;

    const [updated] = await db
      .update(tenantDomains)
      .set({
        status: outcome.status,
        sslStatus: outcome.sslStatus,
        verifiedAt,
        lastCheckedAt: outcome.checkedAt,
        updatedAt: outcome.checkedAt,
      })
      .where(eq(tenantDomains.id, row.id))
      .returning();

    // Routing changes — invalidate the host cache so the next request
    // sees the new status. (Includes negative cache flush.)
    invalidateHostnameCache(row.normalizedHost);

    return NextResponse.json({
      domain: serializeDomain(updated),
      instructions: dnsInstructions(updated.normalizedHost, updated.verificationToken),
      outcome: {
        status: outcome.status,
        sslStatus: outcome.sslStatus,
        txt: outcome.txt,
        cname: outcome.cname,
        reason: outcome.reason ?? null,
        checkedAt: outcome.checkedAt.toISOString(),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
