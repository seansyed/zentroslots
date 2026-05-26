/**
 * Phase SMART-3 — tenant communication intelligence dashboard.
 *
 *   GET /api/tenant/communications/intelligence
 *
 * Admin/manager only. Aggregate metrics for the communication
 * dashboard:
 *   • reminder send/suppress/fail counts + effectiveness pct
 *   • attendance + no-show rate trends (30-day window)
 *   • top 10 high-risk customers (≥3 bookings, sorted by no-show rate)
 *   • top 10 upcoming high-risk bookings (next 7 days)
 *
 * Mirrors the ICAL-4 / SMART-1 / SMART-2 admin-endpoint pattern
 * (requireRole + tenant-scoped + errorResponse).
 */

import { NextRequest, NextResponse } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { computeCommunicationMetrics } from "@/lib/communications/intelligence/communicationMetrics";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const caller = await requireRole(["admin", "manager"]);
    const metrics = await computeCommunicationMetrics(caller.tenantId);
    return NextResponse.json(metrics);
  } catch (err) {
    return errorResponse(err);
  }
}
