/**
 * GET /api/admin/security — SA-7 combined bundle (KPIs + IP intel).
 */
import { NextResponse } from "next/server";
import { computeSecurityKpis, computeIpIntelligence } from "@/lib/admin-analytics/security";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const [kpis, ipIntel] = await Promise.all([
      computeSecurityKpis().catch(() => null),
      computeIpIntelligence().catch(() => null),
    ]);
    return NextResponse.json(
      { kpis, ipIntel, generatedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
