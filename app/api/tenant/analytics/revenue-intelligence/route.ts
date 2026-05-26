/**
 * Phase SMART-4 — revenue intelligence endpoint.
 *
 *   GET /api/tenant/analytics/revenue-intelligence
 *   GET /api/tenant/analytics/revenue-intelligence?days=7
 *
 * Admin/manager only. Returns the unified ROI payload:
 *   • Gross/net revenue (from existing revenueMetrics)
 *   • No-show financial impact (NEW SMART-4 calculator)
 *   • Booking conversion funnel (NEW SMART-4 aggregator)
 *   • Top staff + services by revenue
 *
 * Window: defaults to 30 days; ?days=N (1..90) overrides.
 *
 * Mirrors the ICAL-4 / SMART-1 / SMART-2 / SMART-3 admin endpoint
 * pattern: requireRole + tenant-scoped + errorResponse.
 */

import { NextRequest, NextResponse } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { computeRevenueIntelligence } from "@/lib/analytics/revenue/revenueImpact";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const caller = await requireRole(["admin", "manager"]);

    // Optional ?days=N query param. Clamp to a sensible range so
    // the aggregator can't be coerced into a multi-year scan.
    const url = new URL(req.url);
    const rawDays = url.searchParams.get("days");
    let windowDays = 30;
    if (rawDays) {
      const parsed = parseInt(rawDays, 10);
      if (Number.isFinite(parsed)) {
        windowDays = Math.max(1, Math.min(90, parsed));
      }
    }

    const payload = await computeRevenueIntelligence({
      tenantId: caller.tenantId,
      windowDays,
    });
    return NextResponse.json(payload);
  } catch (err) {
    return errorResponse(err);
  }
}
