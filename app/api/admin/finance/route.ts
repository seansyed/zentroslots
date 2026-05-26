/**
 * GET /api/admin/finance — SA-6 combined bundle.
 *
 * Returns the four sections used by the page client (revenue,
 * dunning, sub-intel, recon) in a single payload. Each section
 * has its own cache TTL inside the lib modules.
 */
import { NextResponse } from "next/server";

import { computeFinanceBundle } from "@/lib/admin-analytics/finance";
import { fetchDunning } from "@/lib/admin-analytics/dunning";
import { computeSubscriptionIntelligence } from "@/lib/admin-analytics/subscription-intelligence";
import { computeReconReport } from "@/lib/admin-analytics/stripe-recon";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireSuperAdmin();
    const [revenue, dunning, subIntel, recon] = await Promise.all([
      computeFinanceBundle().catch(() => null),
      fetchDunning().catch(() => null),
      computeSubscriptionIntelligence().catch(() => null),
      computeReconReport().catch(() => null),
    ]);
    return NextResponse.json(
      { revenue, dunning, subIntel, recon, generatedAt: new Date().toISOString() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
