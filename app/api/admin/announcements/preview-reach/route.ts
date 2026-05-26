/**
 * POST /api/admin/announcements/preview-reach
 *
 * Body: { rules: AudienceRules }
 * Returns: { reach: number, totalActive: number }
 *
 * Read-only. Computes estimated tenant reach for an audience rule set
 * by querying real tenants + bookings data. Powers the audience-preview
 * panel in the announcement builder modal.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";
import { estimateAudienceReach } from "@/lib/admin-analytics/announcements-intelligence";

export const dynamic = "force-dynamic";

const rulesSchema = z.object({
  rules: z.object({
    plans: z.array(z.string()).optional(),
    subscriptionStatuses: z.array(z.string()).optional(),
    onboardingStates: z.array(z.enum(["completed", "incomplete"])).optional(),
    minBookings30d: z.number().int().min(0).optional(),
    inactiveDays: z.number().int().min(0).max(365).optional(),
  }),
});

export async function POST(req: NextRequest) {
  try {
    await requireSuperAdmin();
    const body = rulesSchema.parse(await req.json());
    const result = await estimateAudienceReach(body.rules);
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
