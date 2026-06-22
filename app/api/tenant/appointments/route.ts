/**
 * Phase 17H — admin/staff-driven appointment creation.
 *
 *   POST /api/tenant/appointments
 *
 * Sibling to the public POST /api/bookings. Intentionally separate so
 * the public booking surface stays clean (no internal-only branches)
 * and the contracts can evolve independently:
 *
 *   • public  /api/bookings        — customer self-service, IP rate-
 *                                    limited, intake-required when
 *                                    attached, payment-required when
 *                                    priced.
 *   • tenant  /api/tenant/appointments — admin/manager unrestricted,
 *                                    staff may only create for self,
 *                                    bypasses intake forms, optional
 *                                    payment bypass, optional silent
 *                                    create (no automation email),
 *                                    optional force-book on overlap.
 *
 * The DB-level `bookings_no_overlap` EXCLUDE constraint is the hard
 * backstop against double-booking the same staff at the same time —
 * `forceBook` only suppresses the pre-flight soft warning; the DB
 * still rejects a true conflict with code 23P01.
 *
 * Post-create lifecycle (calendar sync + Teams/Meet link + automation
 * email) is fire-and-forget per the booking POST pattern (commit
 * c8c3af8) — admin doesn't wait for Microsoft Graph latency.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";

import { db } from "@/db/client";
import { getTenantTimezone } from "@/lib/tenant-timezone";
import { buildBookingLabels } from "@/lib/appointment-labels";
import {
  bookings,
  customers,
  serviceStaff,
  services,
  users,
} from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { onBookingCreated } from "@/lib/calendar/sync";
import { triggerAutomation } from "@/lib/communications/engine";
import { enqueueBookingPush } from "@/lib/push/enqueue";
import { loadTenantFeatures } from "@/lib/features";
import { assertCanCreateBooking } from "@/lib/quotas";
import { createAppointmentSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const session = await requireUser();
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const body = createAppointmentSchema.parse(await req.json());

    // ── Role gate ────────────────────────────────────────────────
    // admin / manager: may create for any staff
    // staff:           may create only for themselves
    // anyone else (client): rejected
    if (!["admin", "manager", "staff"].includes(session.role)) {
      throw new HttpError(403, "Not allowed");
    }
    if (session.role === "staff" && body.staffUserId !== session.id) {
      throw new HttpError(
        403,
        "Staff may only create appointments assigned to themselves",
      );
    }

    // ── Service: exists + active + same tenant ──────────────────
    const service = await db.query.services.findFirst({
      where: and(
        eq(services.id, body.serviceId),
        eq(services.tenantId, session.tenantId),
      ),
    });
    if (!service || service.isActive !== 1) {
      throw new HttpError(404, "Service not found");
    }

    // ── Staff: exists + same tenant + delivers this service ─────
    const staff = await db.query.users.findFirst({
      where: and(
        eq(users.id, body.staffUserId),
        eq(users.tenantId, session.tenantId),
      ),
    });
    if (!staff) throw new HttpError(404, "Staff not found");

    const deliverLink = await db.query.serviceStaff.findFirst({
      where: and(
        eq(serviceStaff.serviceId, service.id),
        eq(serviceStaff.userId, staff.id),
        eq(serviceStaff.tenantId, session.tenantId),
      ),
    });
    if (!deliverLink) {
      throw new HttpError(409, "Staff does not deliver this service");
    }

    // ── Plan quota ──────────────────────────────────────────────
    // Same monthly-booking cap as the public flow. Admin creation
    // counts toward the quota — intentional; the system's idea of
    // "bookings this month" should reflect all confirmed appointments
    // regardless of source.
    await assertCanCreateBooking(session.tenantId);

    // ── Time window ─────────────────────────────────────────────
    // The operator types a wall-clock time ("3 PM"). Interpret it in the
    // BUSINESS timezone (server-authoritative) so it means 3 PM at the
    // business regardless of the operator's browser tz — fixing cross-tz
    // booking (e.g. a NY operator booking a CA business). Legacy callers may
    // still send an ISO `startAt`; that's already an absolute instant.
    const tenantTz = await getTenantTimezone(session.tenantId);
    const startAt = body.startLocal
      ? fromZonedTime(body.startLocal, tenantTz)
      : new Date(body.startAt as string);
    if (Number.isNaN(startAt.getTime())) {
      throw new HttpError(400, "Invalid start time");
    }
    const endAt = new Date(startAt.getTime() + service.durationMinutes * 60_000);

    // ── Payment override gate ───────────────────────────────────
    // Paid services normally route through Stripe. The admin must
    // explicitly opt in to skipPayment to confirm the booking
    // without collecting payment. (If the operator later wants to
    // charge the customer, they can issue an invoice out-of-band.)
    if (service.price > 0 && !body.skipPayment) {
      throw new HttpError(
        402,
        "This service requires payment. Set skipPayment=true to admin-book without charging, or send the customer to the public booking link.",
      );
    }

    // ── Resolve / create customer ────────────────────────────────
    let resolvedCustomerId: string | null = null;
    let clientName: string;
    let clientEmail: string;
    if (body.customerId) {
      const existing = await db.query.customers.findFirst({
        where: and(
          eq(customers.id, body.customerId),
          eq(customers.tenantId, session.tenantId),
        ),
      });
      if (!existing) throw new HttpError(404, "Customer not found");
      resolvedCustomerId = existing.id;
      clientName = existing.name;
      clientEmail = existing.email;
    } else if (body.customer) {
      // Quick-create. Use the same dedupe-by-(tenant, lower(email))
      // pattern the public booking POST uses (lines 763-806).
      const existingByEmail = await db
        .select({ id: customers.id, name: customers.name })
        .from(customers)
        .where(
          sql`${customers.tenantId} = ${session.tenantId} AND lower(${customers.email}) = lower(${body.customer.email})`,
        )
        .limit(1);
      if (existingByEmail[0]) {
        resolvedCustomerId = existingByEmail[0].id;
        clientName = body.customer.name;
        clientEmail = body.customer.email;
      } else {
        const [created] = await db
          .insert(customers)
          .values({
            tenantId: session.tenantId,
            name: body.customer.name,
            email: body.customer.email,
            phone: body.customer.phone ?? null,
          })
          .returning();
        resolvedCustomerId = created.id;
        clientName = created.name;
        clientEmail = created.email;
      }
    } else {
      // refine() in the schema already rejects this, defense in depth.
      throw new HttpError(400, "customerId or customer payload required");
    }

    // ── Pre-flight slot overlap warning (only if !forceBook) ─────
    // The DB constraint is the hard backstop; this is the soft
    // pre-check that surfaces a friendlier conflict message.
    if (!body.forceBook) {
      const conflict = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.tenantId, session.tenantId),
            eq(bookings.staffUserId, staff.id),
            eq(bookings.status, "confirmed"),
            // Pass the bounds as ISO strings with an explicit timestamptz
            // cast. Handing a raw JS Date to a raw-sql fragment param made
            // postgres.js serialize it via Buffer.byteLength(Date), which
            // threw a Node TypeError ("Received an instance of Date") on the
            // request path (P0 — leaked to the UI). Typed drizzle ops
            // (.values()/gte()) already stringify timestamps; raw sql does not.
            sql`tstzrange(${bookings.startAt}, ${bookings.endAt}) && tstzrange(${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz)`,
          ),
        )
        .limit(1);
      if (conflict.length > 0) {
        throw new HttpError(
          409,
          "Staff has an overlapping booking at that time. Pick another slot or set forceBook=true to override.",
        );
      }
    }

    // ── Insert ──────────────────────────────────────────────────
    let row;
    try {
      [row] = await db
        .insert(bookings)
        .values({
          tenantId: session.tenantId,
          serviceId: service.id,
          staffUserId: staff.id,
          customerId: resolvedCustomerId,
          clientName,
          clientEmail,
          startAt,
          endAt,
          notes: body.notes ?? null,
          internalNotes: body.internalNotes ?? null,
          status: "confirmed",
          // Operational provenance — Phase 17H surfaces this so the
          // dashboard can show "Created by admin" in the future.
          assignmentMode: "manual_admin",
        })
        .returning();
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") {
        throw new HttpError(409, "Slot just taken — pick another");
      }
      throw e;
    }

    // ── Feature gate for video link auto-create ─────────────────
    const features = await loadTenantFeatures(session.tenantId);
    const wantVideo =
      (service.videoProvider === "google_meet" ||
        service.videoProvider === "teams") &&
      features.googleMeet;

    // ── Background lifecycle (fire-and-forget, post c8c3af8 pattern)
    //
    // We never await calendar sync or automation. The admin's POST
    // returns in ~200ms; Graph/Google latency is invisible to them.
    // The orchestrator persists externalEventId + meetLink directly
    // onto the booking row when the provider responds.
    void onBookingCreated({
      booking: row,
      staff,
      serviceName: service.name,
      videoConference: wantVideo,
      videoProviderHint: service.videoProvider,
    })
      .then((result) => {
        if (result.status === "ok" && result.eventId) {
          return db
            .update(bookings)
            .set({
              externalEventId: result.eventId,
              externalEventProvider: result.provider,
              ...(result.provider === "google"
                ? { googleEventId: result.eventId }
                : {}),
              ...(result.meetLink ? { meetLink: result.meetLink } : {}),
              updatedAt: new Date(),
            })
            .where(eq(bookings.id, row.id));
        }
        return undefined;
      })
      .then(() => {
        // Confirmation automation — admin can opt out (silent
        // create) by setting sendConfirmation=false. When opted out
        // we still create the booking + calendar event; we just
        // skip the customer-facing email + .ics attachment.
        if (!body.sendConfirmation) return undefined;
        return triggerAutomation({
          tenantId: session.tenantId,
          bookingId: row.id,
          eventType: "appointment.created",
          attachIcs: true,
        });
      })
      .catch((bgErr) => {
        console.error(
          "[appointments] background chain failed (booking kept):",
          bgErr,
        );
      });

    // ── Staff-assignment push ───────────────────────────────────
    // Notify the ASSIGNED staff member on their mobile that they have a new
    // appointment. The public POST /api/bookings path already pushes the
    // assigned staff via booking_created; this operator-create path did NOT,
    // so an operator assigning a colleague never reached their device. Reuses
    // the existing booking_created event (no new "staff_assigned" event is
    // invented — there is none). Fire-and-forget; never throws; a no-op when
    // the staff member has no push token or the tenant is a demo tenant.
    void enqueueBookingPush({
      tenantId: session.tenantId,
      booking: {
        id: row.id,
        staffUserId: staff.id,
        clientName: row.clientName,
        startAt: row.startAt,
        serviceId: service.id,
      },
      serviceName: service.name,
      event: "booking_created",
    });

    // ── Audit ───────────────────────────────────────────────────
    audit({
      tenantId: session.tenantId,
      actorUserId: session.id,
      action: "appointment.admin_create",
      entityType: "booking",
      entityId: row.id,
      actorLabel: `${session.email} (admin create)`,
      metadata: {
        serviceId: service.id,
        staffUserId: staff.id,
        startAt: row.startAt.toISOString(),
        sendConfirmation: body.sendConfirmation,
        skipPayment: body.skipPayment,
        forceBook: body.forceBook,
        customerCreated: body.customer !== undefined,
      },
      ipAddress: ip === "anon" ? null : ip,
    });

    // Return business-tz display labels alongside the raw instants so the
    // creating surface shows the time in the business zone immediately.
    return NextResponse.json({
      ...row,
      ...buildBookingLabels(row.startAt, row.endAt, tenantTz),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
