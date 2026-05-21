import { NextResponse } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { computeFairness } from "@/lib/routing/fairness";

/**
 * GET /api/tenant/routing/fairness
 *
 * Per-staff workload + drift snapshot. All numbers come from
 * staff_assignment_stats + the tenant's weighted rule (if any) — no
 * invented metrics. See lib/routing/fairness.ts for math.
 */
export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const fairness = await computeFairness(admin.tenantId);
    return NextResponse.json(fairness);
  } catch (err) {
    return errorResponse(err);
  }
}
