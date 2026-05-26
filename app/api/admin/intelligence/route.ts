/**
 * GET /api/admin/intelligence — SA-8 deterministic intelligence report.
 */
import { NextResponse } from "next/server";
import { computeIntelligenceReport } from "@/lib/admin-analytics/intelligence";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const report = await computeIntelligenceReport();
    return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
