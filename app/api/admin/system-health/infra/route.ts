/**
 * GET /api/admin/system-health/infra — SA-3 Section A backing route.
 *
 * Returns the InfrastructureHealth bundle for the auto-refresh client.
 * Cached 30s server-side; the dashboard polls every 60s so we always
 * serve fresh data.
 */
import { NextResponse } from "next/server";
import { computeInfrastructureHealth } from "@/lib/admin-analytics/health";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const bundle = await computeInfrastructureHealth();
    return NextResponse.json(bundle, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
