import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  services,
  tenants,
  users,
  waitlists,
  waitlistNotifications,
} from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { claimReservation } from "@/lib/waitlists/claimReservation";
import { verifyWaitlistClaimToken } from "@/lib/waitlists/tokens";

// GET /api/public/waitlist/claim/[token]
//
// Returns the slot details so the public claim page can render
// them. Never exposes other customers' info.
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const payload = await verifyWaitlistClaimToken(token);
    if (!payload) throw new HttpError(401, "Invalid or expired claim link");

    const notif = await db.query.waitlistNotifications.findFirst({
      where: and(
        eq(waitlistNotifications.id, payload.notificationId),
        eq(waitlistNotifications.tenantId, payload.tenantId)
      ),
    });
    if (!notif) throw new HttpError(404, "Reservation not found");

    const waitlistRow = await db.query.waitlists.findFirst({
      where: eq(waitlists.id, payload.waitlistId),
    });
    if (!waitlistRow) throw new HttpError(404, "Waitlist entry not found");

    const [service, staff, tenant] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, waitlistRow.serviceId) }),
      notif.staffUserId
        ? db.query.users.findFirst({ where: eq(users.id, notif.staffUserId) })
        : Promise.resolve(undefined),
      db.query.tenants.findFirst({ where: eq(tenants.id, payload.tenantId) }),
    ]);

    return NextResponse.json({
      status: notif.status,
      expiresAt: notif.expiresAt,
      expired: notif.expiresAt.getTime() < Date.now(),
      slot: {
        startAt: notif.slotStartAt,
        endAt: notif.slotEndAt,
      },
      service: service && { id: service.id, name: service.name },
      staff: staff && { name: staff.name, timezone: staff.timezone },
      tenant: tenant && { name: tenant.name, slug: tenant.slug, primaryColor: tenant.primaryColor },
      customer: { name: waitlistRow.customerName, email: waitlistRow.customerEmail },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// POST /api/public/waitlist/claim/[token]
//
// Performs the claim: validates again, inserts the booking, marks
// the notification + waitlist as claimed.
export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await context.params;
    const result = await claimReservation({ token });
    if (!result.ok) {
      const status =
        result.reason === "invalid_token" || result.reason === "expired"
          ? 401
          : result.reason === "slot_taken" || result.reason === "already_claimed"
          ? 409
          : 400;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status });
    }
    return NextResponse.json({ ok: true, bookingId: result.bookingId, meetLink: result.meetLink });
  } catch (err) {
    return errorResponse(err);
  }
}
