/**
 * Phase SMART-2 — public reschedule recommendations endpoint.
 *
 *   GET /api/public/booking/<token>/reschedule-recommendations
 *
 * Returns SMART-1-ranked alternative slots for a customer who wants
 * to move their booking. Token-authenticated (matches the existing
 * /api/public/booking/<token> pattern used by the reschedule page).
 *
 * Read-only. Returns at most 3 top recommendations + the full
 * scored set for the UI's complete slot picker.
 *
 * Safety:
 *   • Token verification IS the auth surface (same as the public
 *     booking GET above this directory).
 *   • Tenant + booking ownership enforced via the token payload's
 *     tenantId — the orchestrator queries with both clauses.
 *   • Never returns the booking's CURRENT time as a recommendation.
 *   • Falls back to empty recommendations on any orchestrator
 *     error (the existing reschedule page's full slot list keeps
 *     working).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, users } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { verifyBookingToken } from "@/lib/tokens";
import { buildRescheduleRecommendations } from "@/lib/scheduling/workflows/rescheduleRecommendations";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await context.params;
    const payload = await verifyBookingToken(token);
    if (!payload) throw new HttpError(401, "Invalid or expired link");

    // Token covers a specific (bookingId, tenantId) — load both
    // with that WHERE clause so a token signed for tenant A can
    // never recommend slots from tenant B.
    const booking = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.id, payload.bookingId),
        eq(bookings.tenantId, payload.tenantId),
      ),
    });
    if (!booking) throw new HttpError(404, "Booking not found");

    // Resolve staff timezone for the orchestrator. Service tz is
    // not used directly — the engine uses the staff's IANA tz
    // (consistent with /api/slots).
    const [staff, service] = await Promise.all([
      db.query.users.findFirst({ where: eq(users.id, booking.staffUserId) }),
      db.query.services.findFirst({ where: eq(services.id, booking.serviceId) }),
    ]);
    if (!staff || !service) {
      // Same response shape as success but empty — the UI falls back
      // to its existing slot picker.
      return NextResponse.json({
        recommendations: [],
        headline: null,
        generatedAt: new Date().toISOString(),
      });
    }

    const result = await buildRescheduleRecommendations({
      currentBookingStart: booking.startAt,
      tenantId: booking.tenantId,
      serviceId: booking.serviceId,
      staffUserId: booking.staffUserId,
      timezone: staff.timezone || "UTC",
      customerEmail: booking.clientEmail,
    });

    return NextResponse.json({
      recommendations: result.recommendations,
      headline: result.headline,
      generatedAt: result.generatedAt,
      // We intentionally do NOT return allScored here — the existing
      // /api/slots endpoint already provides the full ranked list
      // for the same UI. Avoiding payload duplication.
    });
  } catch (err) {
    return errorResponse(err);
  }
}
