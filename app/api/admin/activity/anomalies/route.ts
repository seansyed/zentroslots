/**
 * GET /api/admin/activity/anomalies — SA-5 deterministic anomaly report.
 */
import { NextResponse } from "next/server";
import { computeAnomalies } from "@/lib/admin-analytics/anomalies";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const report = await computeAnomalies();
    return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
