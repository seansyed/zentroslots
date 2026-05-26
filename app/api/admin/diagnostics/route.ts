/**
 * GET /api/admin/diagnostics — internal admin diagnostics bundle.
 *
 * Combines schema fingerprint + snapshot freshness + KPI smoke tests
 * + cache stats. Drives /admin/diagnostics. Super-admin only.
 */
import { NextResponse } from "next/server";
import { computeDiagnostics } from "@/lib/admin-analytics/diagnostics";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const bundle = await computeDiagnostics();
    return NextResponse.json(bundle, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
