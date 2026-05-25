/**
 * Phase SMART-1 — tenant scheduling-intelligence observability.
 *
 *   GET /api/tenant/scheduling/intelligence
 *
 * Admin/manager only. Returns aggregate scheduling metrics:
 *   • per-staff overload risk
 *   • utilization spread + std-dev
 *   • average inter-booking gap
 *   • booking satisfaction proxy (reschedule + no-show inverse)
 *
 * Strictly tenant-scoped (mirrors Phase ICAL-4's
 * /api/admin/calendar-feed-health pattern).
 */

import { NextRequest, NextResponse } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { computeSchedulingIntelligenceMetrics } from "@/lib/scheduling/intelligence/analytics";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const caller = await requireRole(["admin", "manager"]);
    const metrics = await computeSchedulingIntelligenceMetrics(caller.tenantId);
    return NextResponse.json(metrics);
  } catch (err) {
    return errorResponse(err);
  }
}
