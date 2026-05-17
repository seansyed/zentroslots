import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";
import { startImpersonation } from "@/lib/impersonate";
import { audit, ipFromHeaders } from "@/lib/audit";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireSuperAdmin();
    const { id } = await context.params;

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
    if (!tenant) throw new HttpError(404, "Tenant not found");
    if (!tenant.active) throw new HttpError(409, "Cannot impersonate a suspended tenant");

    const jar = await cookies();
    const superToken = jar.get("scheduling_session")?.value;
    if (!superToken) throw new HttpError(401, "No session to preserve");

    const { targetUserId, targetEmail } = await startImpersonation(superToken, id);

    audit({
      tenantId: id,
      action: "admin.impersonate.start",
      actorLabel: admin.email,
      entityType: "user",
      entityId: targetUserId,
      metadata: { targetEmail, byEmail: admin.email },
      ipAddress: ipFromHeaders(req.headers),
    });

    // Return where the UI should navigate after impersonation begins.
    return NextResponse.json({ ok: true, redirectTo: "/dashboard" });
  } catch (err) {
    return errorResponse(err);
  }
}
