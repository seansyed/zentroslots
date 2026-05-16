import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { getPlan } from "@/lib/plans";

const patchSchema = z.object({
  notificationWebhookUrl: z.string().url().nullable().optional(),
  hidePoweredBy: z.boolean().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const body = patchSchema.parse(await req.json());

    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, admin.tenantId) });
    if (!tenant) throw new HttpError(404, "Tenant not found");

    // Plan-gate Powered-By removal: require Pro+ (custom branding flag).
    if (body.hidePoweredBy === true && !getPlan(tenant.currentPlan).limits.customBranding) {
      throw new HttpError(402, "Removing the Powered-by badge requires Pro or higher.");
    }

    const [row] = await db
      .update(tenants)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(tenants.id, admin.tenantId))
      .returning();

    return NextResponse.json({
      notificationWebhookUrl: row.notificationWebhookUrl,
      hidePoweredBy: row.hidePoweredBy,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
