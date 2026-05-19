/**
 * POST /api/tenant/governance/run-retention
 *
 * Manually trigger a retention run for the caller's tenant. NEVER a
 * dry-run by default — the dry-run path is the separate
 * /retention-preview endpoint. Requires explicit body { confirm: true }
 * AND canManageSecurity. Audited.
 *
 * Mostly for emergency / on-demand pruning. The scheduled cron
 * (scripts/run-governance-retention.ts) does the nightly work.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, HttpError } from "@/lib/auth";
import { requirePermissionOrRole } from "@/lib/security/permissions";
import { runTenantRetention } from "@/lib/governance/retention";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  confirm: z.literal(true),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requirePermissionOrRole({
      allowRoles: ["admin"],
      requirePermission: "canManageSecurity",
      auditPath: "/api/tenant/governance/run-retention",
    });

    const raw = await req.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(400, "Must include { confirm: true } in body");
    }

    const summary = await runTenantRetention({
      tenantId: user.tenantId,
      dryRun: false,
      actorUserId: user.id,
    });
    return NextResponse.json(summary);
  } catch (err) {
    return errorResponse(err);
  }
}
