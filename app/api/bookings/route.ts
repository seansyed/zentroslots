import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, customers, intakeForms, serviceStaff, services, tenants, users } from "@/db/schema";
import { sql, asc } from "drizzle-orm";
import { validateResponses, type IntakeField } from "@/lib/intake";
import { errorResponse, getSession, HttpError, isManagerial } from "@/lib/auth";
import { assertResourcesShareTenant } from "@/lib/tenant";
import { createBookingSchema } from "@/lib/validation";
import { getAvailableSlots } from "@/lib/availability";
import { createCalendarEventForStaff } from "@/lib/google";
import { signBookingToken } from "@/lib/tokens";
import { renderConfirmation, sendEmail, type BookingForEmail } from "@/lib/email";
import { assertCanCreateBooking } from "@/lib/quotas";
import { audit, ipFromHeaders } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { buildIcs } from "@/lib/ics";
import { notify } from "@/lib/notify";
import { postTenantWebhook } from "@/lib/outbound";

// List bookings — strictly scoped to the caller's tenant.
// Staff see their own, admins see the whole tenant.
// Optional ?status= filter (one of: pending|confirmed|cancelled|completed|no_show).
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) throw new HttpError(401, "Unauthorized");

    const ninetyDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90);
    const statusFilter = req.nextUrl.searchParams.get("status");
    const validStatuses = ["pending", "confirmed", "cancelled", "completed", "no_show"] as const;

    // Pagination: cursor = ISO timestamp of the previous page's last startAt.
    // Stable + index-aligned (bookings_staff_start_idx / bookings_tenant_idx).
    const cursorParam = req.nextUrl.searchParams.get("cursor");
    const limit = Math.max(1, Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? "50")));
    const cursorAt = cursorParam ? new Date(cursorParam) : null;

    const conds = [
      eq(bookings.tenantId, session.tenantId),
      gte(bookings.startAt, ninetyDaysAgo),
    ];
    if (!isManagerial(session.role)) {
      conds.push(eq(bookings.staffUserId, session.sub));
    }
    if (statusFilter && (validStatuses as readonly string[]).includes(statusFilter)) {
      conds.push(eq(bookings.status, statusFilter as typeof validStatuses[number]));
    }
    if (cursorAt && !Number.isNaN(cursorAt.getTime())) {
      conds.push(lt(bookings.startAt, cursorAt));
    }

    const rows = await db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        status: bookings.status,
        clientName: bookings.clientName,
        clientEmail: bookings.clientEmail,
        notes: bookings.notes,
        meetLink: bookings.meetLink,
        serviceId: bookings.serviceId,
        staffUserId: bookings.staffUserId,
        tenantId: bookings.tenantId,
      })
      .from(bookings)
      .where(and(...conds))
      .orderBy(desc(bookings.startAt))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].startAt.toISOString() : null;

    return NextResponse.json({ rows: page, nextCursor });
  } catch (err) {
    return errorResponse(err);
  }
}

// Public booking creation. Tenant is inferred from the service; staff
// is verified to belong to the same tenant AND to deliver the service.
export async function POST(req: NextRequest) {
  try {
    // Rate limit by IP — 20 bookings per minute per IP. Friendly enough for
    // legit traffic, kills naive script abuse.
    const ip = ipFromHeaders(req.headers) ?? "anon";
    const rl = rateLimit({ key: `booking:${ip}`, capacity: 20, refillTokens: 20, windowMs: 60_000 });
    if (!rl.ok) {
      return NextResponse.json(
        { error: "Too many requests — please slow down." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) } }
      );
    }

    const body = createBookingSchema.parse(await req.json());

    const startAt = new Date(body.startAt);
    if (Number.isNaN(startAt.getTime())) throw new HttpError(400, "Invalid startAt");

    const service = await db.query.services.findFirst({ where: eq(services.id, body.serviceId) });
    if (!service || service.isActive !== 1) throw new HttpError(404, "Service not found");

    // ─── Booking rules (additive, evaluated outside the engine) ─────────
    const now = new Date();
    if (service.minNoticeMinutes && service.minNoticeMinutes > 0) {
      const earliest = new Date(now.getTime() + service.minNoticeMinutes * 60_000);
      if (startAt < earliest) {
        throw new HttpError(409, `This service requires at least ${service.minNoticeMinutes} minutes notice.`);
      }
    }
    if (service.maxAdvanceDays && service.maxAdvanceDays > 0) {
      const latest = new Date(now.getTime() + service.maxAdvanceDays * 24 * 60 * 60_000);
      if (startAt > latest) {
        throw new HttpError(409, `This service can only be booked up to ${service.maxAdvanceDays} days ahead.`);
      }
    }

    // ─── Round-robin assignment ─────────────────────────────────────────
    let staffUserId: string = body.staffUserId;
    if (staffUserId === "auto") {
      const picked = await pickRoundRobinStaff(service.tenantId, service.id);
      if (!picked) throw new HttpError(404, "No staff available to deliver this service");
      staffUserId = picked;
    }

    const staff = await db.query.users.findFirst({ where: eq(users.id, staffUserId) });
    if (!staff) throw new HttpError(404, "Staff not found");

    // Both must live in the same tenant.
    const tenantId = assertResourcesShareTenant(service, staff);

    // Plan quota: refuse if the workspace exceeded its monthly bookings.
    await assertCanCreateBooking(tenantId);

    // Staff must actually deliver this service.
    const link = await db.query.serviceStaff.findFirst({
      where: and(
        eq(serviceStaff.serviceId, service.id),
        eq(serviceStaff.userId, staff.id),
        eq(serviceStaff.tenantId, tenantId)
      ),
    });
    if (!link) throw new HttpError(404, "Staff does not deliver this service");

    // Re-validate the slot is still available. The DB exclusion
    // constraint is the real backstop, but this is the cheap check.
    const date = toYmdInTimezone(startAt, staff.timezone);
    const slots = await getAvailableSlots({
      serviceId: service.id,
      staffUserId: staff.id,
      date,
      timezone: staff.timezone,
    });
    if (!slots.includes(startAt.toISOString())) {
      throw new HttpError(409, "Slot no longer available");
    }

    const endAt = new Date(startAt.getTime() + service.durationMinutes * 60_000);

    // ─── Intake form validation (if service has one attached) ──────────
    let normalisedResponses: Record<string, unknown> | null = null;
    if (service.intakeFormId) {
      const form = await db.query.intakeForms.findFirst({
        where: and(eq(intakeForms.id, service.intakeFormId), eq(intakeForms.tenantId, tenantId)),
      });
      if (form && form.isActive) {
        try {
          normalisedResponses = validateResponses(
            (form.fields as IntakeField[]) ?? [],
            body.intakeResponses ?? {}
          );
        } catch (e) {
          throw new HttpError(400, e instanceof Error ? e.message : "Invalid intake response");
        }
      }
    }

    let row;
    try {
      [row] = await db
        .insert(bookings)
        .values({
          tenantId,
          serviceId: service.id,
          staffUserId: staff.id,
          clientName: body.clientName,
          clientEmail: body.clientEmail,
          startAt,
          endAt,
          notes: body.notes,
          status: "confirmed",
          intakeResponses: normalisedResponses,
          assignmentMode: body.staffUserId === "auto" ? "auto" : "direct",
        })
        .returning();
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") throw new HttpError(409, "Slot just taken — pick another");
      throw e;
    }

    // Video provider: only create a Google Calendar event when the
    // service is configured for Google Meet. Other providers (Zoom/Teams)
    // are wired in a future phase — keeping their booking flows clean
    // (no Meet link) until OAuth is configured.
    if (service.videoProvider === "google_meet") {
      try {
        const ev = await createCalendarEventForStaff({
          staff,
          serviceName: service.name,
          clientName: body.clientName,
          clientEmail: body.clientEmail,
          startAt,
          endAt,
          notes: body.notes,
        });
        if (ev) {
          await db
            .update(bookings)
            .set({ googleEventId: ev.eventId, meetLink: ev.meetLink })
            .where(eq(bookings.id, row.id));
          row.googleEventId = ev.eventId;
          row.meetLink = ev.meetLink;
        }
      } catch (gErr) {
        console.error("Google Calendar create failed (booking kept):", gErr);
      }
    }

    // Best-effort confirmation email with cancel/reschedule tokens + .ics.
    // Wrapped in try/catch so a failing mailer NEVER blocks the booking.
    try {
      const tenant = await db.query.tenants.findFirst({
        where: eq(tenants.id, tenantId),
      });
      const [cancelToken, rescheduleToken] = await Promise.all([
        signBookingToken({ bookingId: row.id, tenantId, kind: "cancel" }),
        signBookingToken({ bookingId: row.id, tenantId, kind: "reschedule" }),
      ]);
      const ep: BookingForEmail = {
        id: row.id,
        serviceName: service.name,
        staffName: staff.name,
        staffEmail: staff.email,
        startAt: row.startAt,
        endAt: row.endAt,
        clientName: row.clientName,
        clientEmail: row.clientEmail,
        clientTimezone: staff.timezone,
        meetLink: row.meetLink,
        tenantName: tenant?.name ?? "",
        cancelToken,
        rescheduleToken,
      };
      const tpl = renderConfirmation(ep);
      const ics = buildIcs({
        uid: `${row.id}@scheduling-saas`,
        start: row.startAt,
        end: row.endAt,
        summary: `${service.name} with ${staff.name}`,
        description: body.notes ?? "",
        location: row.meetLink ?? undefined,
        organizerEmail: staff.email,
        organizerName: staff.name,
        attendeeEmail: row.clientEmail,
        attendeeName: row.clientName,
        method: "REQUEST",
      });
      await sendEmail({
        to: row.clientEmail,
        ...tpl,
        attachments: [{ filename: "invite.ics", content: ics, contentType: "text/calendar; charset=utf-8; method=REQUEST" }],
        audit: { tenantId, kind: "confirmation", bookingId: row.id },
      });
    } catch (eErr) {
      console.error("Confirmation email failed (booking kept):", eErr);
    }

    // Best-effort customer upsert — make every public booking promote
    // the client to a first-class CRM record. Wrapped in try/catch so a
    // failure NEVER blocks the booking; we already returned the row.
    try {
      const customerId = await upsertCustomer({
        tenantId,
        name: row.clientName,
        email: row.clientEmail,
      });
      if (customerId) {
        await db
          .update(bookings)
          .set({ customerId })
          .where(eq(bookings.id, row.id));
      }
    } catch (cErr) {
      console.error("Customer upsert failed (booking kept):", cErr);
    }

    // Best-effort in-app notification for the assigned staff. Never throws.
    notify({
      tenantId,
      userId: staff.id,
      kind: "booking.created",
      title: `New booking: ${row.clientName}`,
      body: `${service.name} on ${row.startAt.toISOString()}`,
      link: "/dashboard/appointments",
      metadata: { bookingId: row.id, clientEmail: row.clientEmail },
    });

    // Best-effort outbound webhook (Slack-compatible). Never throws.
    postTenantWebhook({
      tenantId,
      text: `📅 New booking: ${row.clientName} — ${service.name} with ${staff.name} on ${row.startAt.toISOString()}`,
      metadata: { event: "booking.created", bookingId: row.id, clientEmail: row.clientEmail },
    });

    // Best-effort audit. Never throws.
    audit({
      tenantId,
      action: "booking.create",
      entityType: "booking",
      entityId: row.id,
      actorLabel: `${row.clientName} <${row.clientEmail}>`,
      metadata: { serviceId: service.id, staffId: staff.id, startAt: row.startAt.toISOString() },
      ipAddress: ip === "anon" ? null : ip,
    });

    return NextResponse.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Pick the staff member who delivers this service AND has the oldest
 * most-recent booking — simple round-robin without persistent counters.
 * Returns null if no staff is assigned to the service.
 */
async function pickRoundRobinStaff(tenantId: string, serviceId: string): Promise<string | null> {
  // SELECT s.user_id, MAX(b.start_at) AS last_at
  // FROM service_staff s
  // LEFT JOIN bookings b ON b.staff_user_id = s.user_id AND b.status='confirmed'
  // WHERE s.service_id = ? AND s.tenant_id = ?
  // GROUP BY s.user_id ORDER BY last_at NULLS FIRST LIMIT 1
  const rows = await db.execute(sql`
    SELECT s.user_id, MAX(b.start_at) AS last_at
    FROM service_staff s
    LEFT JOIN bookings b
      ON b.staff_user_id = s.user_id
     AND b.status = 'confirmed'
     AND b.tenant_id = s.tenant_id
    WHERE s.service_id = ${serviceId} AND s.tenant_id = ${tenantId}
    GROUP BY s.user_id
    ORDER BY last_at ASC NULLS FIRST
    LIMIT 1
  `);
  const first = (rows as unknown as Array<{ user_id?: string }>)[0];
  return first?.user_id ?? null;
}

function toYmdInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Find a customer by (tenant, lower(email)) or create one. Returns the
 * customer id. Designed for the booking-create hook: caller wraps in
 * try/catch so failure never blocks the booking.
 */
async function upsertCustomer(args: {
  tenantId: string;
  name: string;
  email: string;
}): Promise<string | null> {
  const existing = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(
      sql`${customers.tenantId} = ${args.tenantId} AND lower(${customers.email}) = lower(${args.email})`
    )
    .limit(1);
  if (existing[0]) {
    // Optionally update the name if it changed (last-write-wins for casual rename).
    if (existing[0].name !== args.name) {
      await db
        .update(customers)
        .set({ name: args.name, updatedAt: new Date() })
        .where(eq(customers.id, existing[0].id));
    }
    return existing[0].id;
  }
  try {
    const [row] = await db
      .insert(customers)
      .values({
        tenantId: args.tenantId,
        name: args.name,
        email: args.email,
      })
      .returning();
    return row.id;
  } catch {
    // Race: another insert won the unique constraint; re-read and return.
    const second = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        sql`${customers.tenantId} = ${args.tenantId} AND lower(${customers.email}) = lower(${args.email})`
      )
      .limit(1);
    return second[0]?.id ?? null;
  }
}
