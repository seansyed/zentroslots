/**
 * GET /api/admin/billing/validate — Stabilization Wave billing audit.
 *
 * Returns a deterministic report of billing anomalies. Read-only.
 */
import { NextResponse } from "next/server";
import { computeBillingValidation } from "@/lib/admin-analytics/billingValidator";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const report = await computeBillingValidation();
    return NextResponse.json(report, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
