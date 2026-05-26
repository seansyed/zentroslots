/**
 * GET /api/admin/system-health/integrations — SA-3 Section B.
 */
import { NextResponse } from "next/server";
import { computeIntegrationsMatrix } from "@/lib/admin-analytics/integrations";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const bundle = await computeIntegrationsMatrix();
    return NextResponse.json(bundle, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
