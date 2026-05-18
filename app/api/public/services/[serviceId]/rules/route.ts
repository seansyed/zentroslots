import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { services } from "@/db/schema";
import { resolveBookingRules } from "@/lib/booking-rules/resolveRules";
import { errorResponse, HttpError } from "@/lib/auth";

// GET /api/public/services/:serviceId/rules
//
// Public, unauthenticated. Returns ONLY the customer-safe surface of
// the effective booking rule:
//   - blackoutDates (so the date strip can grey them out)
//   - earliestBookable (clamped by minNoticeMinutes)
//   - latestBookable (clamped by maxAdvanceDays)
//   - businessHours (when requireBusinessHours is on)
//
// Caps / cooldown / per-customer limits are NOT exposed — they're
// enforced on submit only. Surfacing them client-side would be both
// a leak and useless (cooldown depends on the customer's history).
export async function GET(
  _req: Request,
  context: { params: Promise<{ serviceId: string }> }
) {
  try {
    const { serviceId } = await context.params;
    const service = await db.query.services.findFirst({
      where: eq(services.id, serviceId),
    });
    if (!service || service.isActive !== 1) {
      throw new HttpError(404, "Service not found");
    }

    const rule = await resolveBookingRules({
      tenantId: service.tenantId,
      serviceId,
      locationId: null,
    });

    const now = Date.now();
    const earliest = rule.minNoticeMinutes
      ? new Date(now + rule.minNoticeMinutes * 60_000).toISOString()
      : null;
    const latest = rule.maxAdvanceDays
      ? new Date(now + rule.maxAdvanceDays * 24 * 60 * 60_000).toISOString()
      : null;

    return NextResponse.json({
      blackoutDates: rule.blackoutDates,
      earliestBookable: earliest,
      latestBookable: latest,
      requireBusinessHours: rule.requireBusinessHours,
      businessHours: rule.requireBusinessHours ? rule.businessHours : {},
    });
  } catch (err) {
    return errorResponse(err);
  }
}
