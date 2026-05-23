/**
 * Operational Hardening Wave — payment-ops summary endpoint.
 *
 *   GET /api/tenant/payment-ops/summary
 *
 * Admin-only. Per-tenant rollup of operational metrics. Wraps the
 * shared aggregator with tenant scoping.
 */

import { NextResponse } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { getTenantPaymentVaultMetrics } from "@/lib/payments/opsMetrics";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireRole(["admin"]);
    const metrics = await getTenantPaymentVaultMetrics(user.tenantId);
    return NextResponse.json({ metrics });
  } catch (err) {
    return errorResponse(err);
  }
}
