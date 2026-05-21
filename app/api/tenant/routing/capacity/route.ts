import { NextResponse } from "next/server";

import { errorResponse, requireRole } from "@/lib/auth";
import { computeCapacity } from "@/lib/routing/capacity";

/**
 * GET /api/tenant/routing/capacity
 *
 * Per-staff capacity forecast for the rest of today, sourced from
 * real working hours + confirmed bookings. See lib/routing/capacity.ts
 * for math. No fake analytics — anything not observable today is
 * absent from the response (e.g. external Google busy time is NOT
 * subtracted; the UI notes this honestly).
 */
export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const capacity = await computeCapacity(admin.tenantId);
    return NextResponse.json(capacity);
  } catch (err) {
    return errorResponse(err);
  }
}
