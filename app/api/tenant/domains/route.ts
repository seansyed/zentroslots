import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { z } from "zod";

import { db } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireRole, requireUser } from "@/lib/auth";
import {
  CNAME_TARGET,
  TXT_PREFIX,
  dnsInstructions,
  invalidateHostnameCache,
  serializeDomain,
  validateHostname,
} from "@/lib/domains";

/**
 * /api/tenant/domains
 *   GET  — list domains for the calling tenant (full lifecycle data)
 *   POST — create a new pending domain + return DNS instructions
 *
 * Phase 15A: the schema now carries normalizedHost / status / sslStatus
 * / lastCheckedAt — this route populates them all. Verification lives at
 * /api/tenant/domains/[id]/verify; deletion at DELETE on the [id] route.
 */

const createSchema = z.object({
  // Use the same validator the UI relies on so client/server errors stay
  // consistent. Format-level errors are returned as 400.
  hostname: z.string().min(1).max(253),
});

export async function GET() {
  try {
    const caller = await requireUser();
    const rows = await db
      .select()
      .from(tenantDomains)
      .where(eq(tenantDomains.tenantId, caller.tenantId))
      .orderBy(tenantDomains.createdAt);
    return NextResponse.json({
      domains: rows.map(serializeDomain),
      config: { cnameTarget: CNAME_TARGET, txtPrefix: TXT_PREFIX },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const ipAddress = ipFromHeaders(req.headers);
    const body = createSchema.parse(await req.json());

    const v = validateHostname(body.hostname);
    if (!v.ok) throw new HttpError(400, v.error);
    const host = v.host;

    // Check global uniqueness on normalizedHost (enforced by unique index
    // in migration 0038, but we surface a friendly 409 first).
    const existing = await db
      .select({ id: tenantDomains.id, tenantId: tenantDomains.tenantId })
      .from(tenantDomains)
      .where(sql`${tenantDomains.normalizedHost} = ${host}`)
      .limit(1);
    if (existing[0]) {
      if (existing[0].tenantId !== admin.tenantId) {
        throw new HttpError(409, "This domain is already claimed by another workspace");
      }
      const fresh = await db.query.tenantDomains.findFirst({
        where: eq(tenantDomains.id, existing[0].id),
      });
      if (!fresh) throw new HttpError(500, "Domain disappeared mid-request");
      return NextResponse.json({
        domain: serializeDomain(fresh),
        instructions: dnsInstructions(fresh.normalizedHost, fresh.verificationToken),
      });
    }

    const verificationToken = crypto.randomBytes(16).toString("hex");
    const [row] = await db
      .insert(tenantDomains)
      .values({
        tenantId: admin.tenantId,
        host: body.hostname,
        normalizedHost: host,
        verificationToken,
        status: "pending",
        sslStatus: "pending",
      })
      .returning();

    // Custom domains start pending — they're not in the routing pool yet,
    // but invalidate defensively in case a stale negative entry exists.
    invalidateHostnameCache(host);

    await audit({
      tenantId: admin.tenantId,
      action: "domain.added",
      actorUserId: admin.id,
      entityType: "tenant_domain",
      entityId: row.id,
      ipAddress,
      metadata: { host },
    });

    return NextResponse.json(
      {
        domain: serializeDomain(row),
        instructions: dnsInstructions(host, verificationToken),
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

// Serializer lives in lib/domains.ts so the verify + delete routes can
// share it. Next.js requires route files to export ONLY the HTTP handler
// names — any additional export breaks the route type contract.
