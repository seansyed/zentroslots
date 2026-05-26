/**
 * GET /api/admin/system-health/comms — SA-3 Section C.
 */
import { NextResponse } from "next/server";
import { computeCommsMonitoring } from "@/lib/admin-analytics/comms";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const bundle = await computeCommsMonitoring();
    return NextResponse.json(bundle, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
