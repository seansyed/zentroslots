import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { z } from "zod";

import { db } from "@/db/client";
import { tenantDomains } from "@/db/schema";
import { errorResponse, HttpError, requireRole, requireUser } from "@/lib/auth";

const HOST_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

const createSchema = z.object({
  host: z.string().regex(HOST_RE, "expected hostname like book.acme.com"),
});

export async function GET() {
  try {
    const caller = await requireUser();
    const rows = await db
      .select()
      .from(tenantDomains)
      .where(eq(tenantDomains.tenantId, caller.tenantId));
    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const body = createSchema.parse(await req.json());

    // Reject if host already claimed by another tenant.
    const existing = await db
      .select({ id: tenantDomains.id, tenantId: tenantDomains.tenantId })
      .from(tenantDomains)
      .where(sql`lower(${tenantDomains.host}) = lower(${body.host})`)
      .limit(1);
    if (existing[0]) {
      if (existing[0].tenantId !== admin.tenantId) {
        throw new HttpError(409, "This domain is already claimed");
      }
      // Same tenant re-adding — return existing row.
      const fresh = await db.query.tenantDomains.findFirst({
        where: eq(tenantDomains.id, existing[0].id),
      });
      return NextResponse.json(fresh);
    }

    const verificationToken = crypto.randomBytes(16).toString("hex");
    const [row] = await db
      .insert(tenantDomains)
      .values({
        tenantId: admin.tenantId,
        host: body.host.toLowerCase(),
        verificationToken,
      })
      .returning();
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
