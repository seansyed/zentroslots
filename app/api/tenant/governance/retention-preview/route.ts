/**
 * POST /api/tenant/governance/retention-preview
 *
 * Dry-run the retention engine for the caller's tenant. Returns counts
 * per resource; deletes nothing. Used by the governance dashboard's
 * "Preview" button so an admin sees exactly what configuring a window
 * would prune BEFORE clicking Save.
 *
 * Gated by canManageSecurity. Tenant-scoped.
 */

import { NextResponse } from "next/server";

import { errorResponse } from "@/lib/auth";
import { requirePermissionOrRole } from "@/lib/security/permissions";
import { runTenantRetention } from "@/lib/governance/retention";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const user = await requirePermissionOrRole({
      allowRoles: ["admin"],
      requirePermission: "canManageSecurity",
      auditPath: "/api/tenant/governance/retention-preview",
    });
    const summary = await runTenantRetention({
      tenantId: user.tenantId,
      dryRun: true,
      actorUserId: user.id,
    });
    return NextResponse.json(summary);
  } catch (err) {
    return errorResponse(err);
  }
}
