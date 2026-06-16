/**
 * GET /api/bookings/[id]
 *
 * Single-booking detail. Returns the booking row joined with service
 * + staff + customer so the mobile detail screen renders without
 * follow-up round-trips.
 *
 * Tenant + role scoping mirrors GET /api/bookings (list):
 *   - admin / manager: any booking inside their tenant
 *   - staff:           only their own bookings
 *   - other roles:     404 (we hide existence)
 *
 * Phase 1B (2026-05-27) — additive route. List + per-id sub-actions
 * (cancel / reschedule / status / intake-responses) were already
 * present; this just fills the obvious gap.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, customers, services, users } from "@/db/schema";
import { errorResponse, HttpError, isManagerial, requireUser } from "@/lib/auth";
import { buildBookingLabels } from "@/lib/appointment-labels";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");

    const row = await db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        status: bookings.status,
        clientName: bookings.clientName,
        clientEmail: bookings.clientEmail,
        notes: bookings.notes,
        internalNotes: bookings.internalNotes,
        meetLink: bookings.meetLink,
        externalEventProvider: bookings.externalEventProvider,
        meetingProvider: bookings.meetingProvider,
        // Service join
        serviceId: bookings.serviceId,
        serviceName: services.name,
        serviceDurationMinutes: services.durationMinutes,
        servicePrice: services.price,
        serviceDescription: services.description,
        serviceVideoProvider: services.videoProvider,
        // Staff join
        staffUserId: bookings.staffUserId,
        staffName: users.name,
        staffEmail: users.email,
        // Customer join (optional — public bookings may not have one)
        customerId: bookings.customerId,
        customerPhone: customers.phone,
        // Tenant scope (returned for caller-side defense in depth)
        tenantId: bookings.tenantId,
      })
      .from(bookings)
      .leftJoin(services, eq(services.id, bookings.serviceId))
      .leftJoin(users, eq(users.id, bookings.staffUserId))
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .where(and(eq(bookings.id, id), eq(bookings.tenantId, caller.tenantId)))
      .limit(1);

    const booking = row[0];
    if (!booking) throw new HttpError(404, "Not found");

    // Staff role: only their own bookings (defense in depth alongside
    // tenant scope on the where clause above).
    if (!isManagerial(caller.role) && booking.staffUserId !== caller.id) {
      throw new HttpError(404, "Not found");
    }

    return NextResponse.json({
      id: booking.id,
      startAt: booking.startAt,
      endAt: booking.endAt,
      status: booking.status,
      clientName: booking.clientName,
      clientEmail: booking.clientEmail,
      clientPhone: booking.customerPhone ?? null,
      customerId: booking.customerId ?? null,
      notes: booking.notes ?? null,
      // Internal notes are visible to admins/managers only; staff see null.
      internalNotes: isManagerial(caller.role) ? booking.internalNotes ?? null : null,
      meetLink: booking.meetLink ?? null,
      meetingProvider:
        booking.meetingProvider ??
        booking.externalEventProvider ??
        booking.serviceVideoProvider ??
        null,
      location: null,
      amountCents: null,
      service: {
        id: booking.serviceId,
        name: booking.serviceName ?? "Appointment",
        description: booking.serviceDescription ?? null,
        durationMinutes: booking.serviceDurationMinutes ?? null,
        priceCents: booking.servicePrice ?? null,
      },
      staff: {
        id: booking.staffUserId,
        name: booking.staffName ?? "Staff",
        email: booking.staffEmail ?? null,
      },
      // Viewer-tz display labels (matches the web dashboard); mobile renders
      // these verbatim instead of formatting an IANA zone on-device.
      ...buildBookingLabels(booking.startAt, booking.endAt, caller.timezone),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
