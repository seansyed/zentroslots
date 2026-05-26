/**
 * Phase SMART-2 — tenant scheduling workflow metrics.
 *
 *   GET /api/tenant/scheduling/workflow-metrics
 *
 * Admin/manager only. Returns aggregate metrics over the workflow
 * surface (cancellations + recovery, waitlist conversion,
 * automation queue depth, estimated reschedules).
 *
 * Mirrors the Phase ICAL-4 /api/admin/calendar-feed-health pattern
 * (auth + tenant-scoped) and the Phase SMART-1
 * /api/tenant/scheduling/intelligence pattern.
 */

import { NextRequest, NextResponse } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { computeWorkflowMetrics } from "@/lib/scheduling/workflows/workflowMetrics";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const caller = await requireRole(["admin", "manager"]);
    const metrics = await computeWorkflowMetrics(caller.tenantId);
    return NextResponse.json(metrics);
  } catch (err) {
    return errorResponse(err);
  }
}
