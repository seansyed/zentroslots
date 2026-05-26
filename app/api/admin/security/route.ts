/**
 * GET /api/admin/security — SA-7 combined bundle (KPIs + IP intel).
 */
import { NextResponse } from "next/server";
import { computeSecurityKpis, computeIpIntelligence } from "@/lib/admin-analytics/security";
import {
  computeSecurityMissionKpis,
  deriveSecurityInsights,
} from "@/lib/admin-analytics/security-intelligence";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const [kpis, ipIntel, mission] = await Promise.all([
      computeSecurityKpis().catch(() => null),
      computeIpIntelligence().catch(() => null),
      computeSecurityMissionKpis().catch(() => null),
    ]);
    const insights = mission ? deriveSecurityInsights(mission) : [];
    return NextResponse.json(
      { kpis, ipIntel, mission, insights, generatedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
