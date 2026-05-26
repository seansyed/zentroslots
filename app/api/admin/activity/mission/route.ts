/**
 * GET /api/admin/activity/mission — Activity Mission Control KPIs.
 *
 * Returns the executive hero strip data: 24h incident counts, throughput
 * series, anomaly score, stream health classification.
 *
 * Memoized 30s inside computeActivityMissionKpis(). Live mode polls
 * this every 15s; cached mode polls every 60s.
 */
import { NextResponse } from "next/server";
import { computeActivityMissionKpis } from "@/lib/admin-analytics/activity-mission-control";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const kpis = await computeActivityMissionKpis();
    return NextResponse.json(kpis, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
