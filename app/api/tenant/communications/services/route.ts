import { NextResponse } from "next/server";
import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { services } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

// GET /api/tenant/communications/services
//
// Returns the caller-tenant's active services with the count of
// communication-template overrides each one carries. Powers the
// templates page's scope picker — admins can see which services have
// custom messaging at a glance.

export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);

    const rows = await db
      .select({
        id: services.id,
        name: services.name,
        slug: services.slug,
        overrideCount: sql<number>`(
          SELECT COUNT(*)::int FROM communication_templates ct
          WHERE ct.tenant_id = ${services.tenantId}
            AND ct.service_id = ${services.id}
            AND ct.channel = 'email'
        )`,
      })
      .from(services)
      .where(and(eq(services.tenantId, admin.tenantId), eq(services.isActive, 1)))
      .orderBy(asc(services.name));

    return NextResponse.json(rows);
  } catch (err) {
    return errorResponse(err);
  }
}
