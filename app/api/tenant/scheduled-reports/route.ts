import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { scheduledReports } from "@/db/schema";
import { errorResponse } from "@/lib/auth";
import { requirePermissionOrRole } from "@/lib/security/permissions";

// GET /api/tenant/scheduled-reports?period_type=weekly
//
// Lists past scheduled reports for the caller-tenant. Tenant-isolated.
// The cron worker populates rows; this endpoint is read-only.
export async function GET(req: NextRequest) {
  try {
    const admin = await requirePermissionOrRole({
      allowRoles: ["admin", "manager"],
      requirePermission: "canViewExecutiveAnalytics",
      auditPath: "/api/tenant/scheduled-reports",
    });
    const periodTypeParam = req.nextUrl.searchParams.get("period_type");

    const conds = [eq(scheduledReports.tenantId, admin.tenantId)];
    if (periodTypeParam && ["daily", "weekly", "monthly"].includes(periodTypeParam)) {
      conds.push(eq(scheduledReports.periodType, periodTypeParam));
    }

    const rows = await db
      .select()
      .from(scheduledReports)
      .where(and(...conds))
      .orderBy(desc(scheduledReports.generatedAt))
      .limit(50);

    return NextResponse.json({ reports: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
