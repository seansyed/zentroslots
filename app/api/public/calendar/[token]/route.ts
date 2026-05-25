/**
 * Phase ICAL-1 — public signed-token .ics download.
 *
 *   GET /api/public/calendar/<token>
 *
 * Serves the .ics for a booking when the caller presents a valid
 * signed token (`BookingTokenPayload` with kind="ics"). The token is
 * issued in two places:
 *   • The booking confirmation page (rendered server-side; passes a
 *     freshly-signed token to the AddToCalendarButtons component).
 *   • Future: the customer-facing email body (replaces the static
 *     attachment with a re-downloadable link).
 *
 * Security posture:
 *   • Signed token = the entire auth surface. No session check, no
 *     cookie, no tenant header — the token IS the proof of
 *     authorization for this specific booking.
 *   • Token is bound to a single bookingId + tenantId; cross-tenant
 *     access impossible.
 *   • 30-day TTL (inherited from signBookingToken).
 *   • No internal IDs leak in the response body — only the rendered
 *     calendar fields (service name, start/end, host name, meeting
 *     link).
 *   • Cache-Control: no-store so refreshes always reflect the
 *     latest booking state (sequence advance + cancellation status).
 *   • Content-Disposition: attachment forces the browser to save
 *     rather than render in-tab — Apple Calendar's URL handler
 *     fires on the saved .ics double-click.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { verifyBookingToken } from "@/lib/tokens";
import { generateBookingIcs } from "@/lib/calendar/ics/booking-ics";

export const dynamic = "force-dynamic";

function notFound(): NextResponse {
  // Same response for "bad token" + "booking not found" + "wrong
  // kind" — never disclose which failed (token enumeration defense).
  return new NextResponse("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  if (!token) return notFound();

  const payload = await verifyBookingToken(token);
  if (!payload || payload.kind !== "ics") return notFound();

  // Load everything we need in one round trip, with tenant isolation
  // enforced via WHERE tenant_id = <token.tenantId>. A token signed
  // for tenant A can NEVER pull a row from tenant B.
  const row = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      clientEmail: bookings.clientEmail,
      clientName: bookings.clientName,
      notes: bookings.notes,
      meetLink: bookings.meetLink,
      updatedAt: bookings.updatedAt,
      serviceName: services.name,
      staffEmail: users.email,
      staffName: users.name,
      staffTimezone: users.timezone,
      tenantName: tenants.name,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .leftJoin(users, eq(users.id, bookings.staffUserId))
    .leftJoin(tenants, eq(tenants.id, bookings.tenantId))
    .where(
      and(
        eq(bookings.id, payload.bookingId),
        eq(bookings.tenantId, payload.tenantId),
      ),
    )
    .limit(1);

  const r = row[0];
  if (!r || !r.serviceName || !r.staffEmail || !r.staffName || !r.tenantName) {
    return notFound();
  }

  // Method derived from current booking status — if the booking was
  // cancelled AFTER the token was issued, this still serves the
  // correct CANCEL .ics so the user's calendar reflects reality.
  const isCancelled =
    r.status === "cancelled" || r.status === "no_show" || r.status === "refunded";

  const ics = generateBookingIcs({
    booking: {
      id: r.id,
      startAt: r.startAt,
      endAt: r.endAt,
      clientEmail: r.clientEmail,
      clientName: r.clientName,
      notes: r.notes,
      meetLink: r.meetLink,
      updatedAt: r.updatedAt,
    },
    service: { name: r.serviceName },
    staff: {
      email: r.staffEmail,
      name: r.staffName,
      timezone: r.staffTimezone ?? "UTC",
    },
    tenant: { name: r.tenantName },
    method: isCancelled ? "CANCEL" : "REQUEST",
    // Default reminders for the downloaded .ics (24h + 15min). These
    // are suppressed on CANCEL events by the builder.
    alarms: [{ minutesBefore: 1440 }, { minutesBefore: 15 }],
  });

  return new NextResponse(ics.body, {
    status: 200,
    headers: {
      "Content-Type": ics.contentType,
      // attachment + filename = iPhone Safari saves to Downloads,
      // then Apple Calendar's URL handler picks it up on tap.
      "Content-Disposition": `attachment; filename="${ics.filename}"`,
      // Never cache — booking state can change (reschedule, cancel,
      // notes update) and the URL is per-token so CDN caching would
      // serve stale ICS to other users sharing the same edge node.
      "Cache-Control": "no-store, must-revalidate",
      // Defense in depth: no sniffing, no framing.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
