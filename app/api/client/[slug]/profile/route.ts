import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { customers, tenants } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { getClientSession } from "@/lib/client-auth";
import { audit, ipFromHeaders } from "@/lib/audit";

// PATCH /api/client/[slug]/profile
//
// Lets the signed-in client update their own customer record. Strict
// allow-list: only `name` and `phone` are mutable. Email stays read-only
// because changing it would break the magic-link auth contract (we use
// email as the lookup key). Status/tags/notes are operator-controlled.

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  // Loose validation — phone formats vary internationally; we just cap
  // length and let the tenant's own systems reject malformed numbers.
  phone: z.string().max(40).nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await context.params;

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
    if (!tenant || !tenant.active) throw new HttpError(404, "Workspace not found");

    const session = await getClientSession();
    if (!session || session.tenantId !== tenant.id) {
      throw new HttpError(401, "Not signed in");
    }

    const body = patchSchema.parse(await req.json());
    if (body.name === undefined && body.phone === undefined) {
      throw new HttpError(400, "Nothing to update");
    }

    const existing = await db.query.customers.findFirst({
      where: and(eq(customers.id, session.customerId), eq(customers.tenantId, tenant.id)),
    });
    if (!existing) throw new HttpError(404, "Customer record not found");

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.phone !== undefined) patch.phone = body.phone === null ? null : body.phone.trim() || null;

    const [updated] = await db
      .update(customers)
      .set(patch)
      .where(and(eq(customers.id, session.customerId), eq(customers.tenantId, tenant.id)))
      .returning();

    audit({
      tenantId: tenant.id,
      action: "client.profile.update",
      entityType: "customer",
      entityId: updated.id,
      actorLabel: `${updated.name} <${updated.email}>`,
      metadata: {
        changedFields: Object.keys(patch).filter((k) => k !== "updatedAt"),
      },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      status: updated.status,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
