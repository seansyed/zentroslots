/**
 * GET /api/tenant/seats — workforce seat snapshot for the calling
 * tenant. Backs the Staff page's seat capacity chip and the
 * CapacityReachedModal gating logic.
 *
 * Tenant-scoped via requireUser(). No new tables, no schema changes,
 * no Stripe rewrites. The math is in lib/billing/seats.ts.
 */
import { NextResponse } from "next/server";

import { errorResponse, requireUser } from "@/lib/auth";
import { getWorkforceSeats, toWorkforceSeatsJson } from "@/lib/billing/seats";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const caller = await requireUser();
    const snapshot = await getWorkforceSeats(caller.tenantId);
    return NextResponse.json(toWorkforceSeatsJson(snapshot));
  } catch (err) {
    return errorResponse(err);
  }
}
