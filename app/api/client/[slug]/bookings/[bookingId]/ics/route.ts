import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, customers, services, tenants, users } from "@/db/schema";
import { getClientSession } from "@/lib/client-auth";
import { buildIcs } from "@/lib/ics";

/**
 * GET /api/client/[slug]/bookings/[bookingId]/ics
 *
 * Authenticated ICS download for a single booking. Returns an RFC 5545
 * `text/calendar` attachment so the customer can drop the appointment
 * into Apple Calendar / Outlook / any iCal-aware client without going
 * back to the confirmation email.
 *
 * Authorization chain — three layers:
 *   1. Tenant slug → tenant row exists + active
 *   2. Client session cookie → present + tenantId matches this tenant
 *   3. Booking exists for THIS tenant AND its clientEmail matches the
 *      authenticated customer's email (case-insensitive)
 *
 * Any failure returns 404 (not 401/403) — we don't leak whether the
 * booking exists for someone other than the requester.
 *
 * Why a Route Handler instead of inlining ICS generation in the
 * bookings page:
 *   • The bookings page is a server component; clicking an inline
 *     download would require a `<form action=...>` or a client-side
 *     fetch + Blob. A dedicated GET endpoint is cleaner — the browser
 *     follows the `Content-Disposition: attachment` natively.
 *   • Centralizing the auth check + ICS serialization keeps both
 *     consistent with the existing `buildIcs()` used in confirmation
 *     emails — same UID, same fields, same calendar-app behavior.
 */
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ slug: string; bookingId: string }> },
) {
  const { slug, bookingId } = await context.params;

  // Helper — every authorization failure returns the same 404 so we
  // don't disclose booking existence to unauthenticated probes.
  const notFound = () =>
    new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.active) return notFound();

  const session = await getClientSession();
  if (!session || session.tenantId !== tenant.id) return notFound();

  const customer = await db.query.customers.findFirst({
    where: and(eq(customers.id, session.customerId), eq(customers.tenantId, tenant.id)),
    columns: { email: true, name: true },
  });
  if (!customer) return notFound();

  // Join service + staff for richer ICS content. Booking ownership is
  // enforced via case-insensitive email-equality (the canonical
  // ownership rule used everywhere else in the portal).
  const [row] = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      meetLink: bookings.meetLink,
      clientEmail: bookings.clientEmail,
      serviceName: services.name,
      staffName: users.name,
      staffEmail: users.email,
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .innerJoin(users, eq(users.id, bookings.staffUserId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenant.id)))
    .limit(1);

  if (!row) return notFound();
  if (row.clientEmail.toLowerCase() !== customer.email.toLowerCase()) return notFound();

  // Build the ICS body. Same generator the confirmation email uses,
  // same UID format so re-imports update the existing calendar entry
  // instead of duplicating.
  // (Best-effort host for the UID — fall back to a stable string when
  // the env var isn't set so the UID is at least deterministic per
  // booking id.)
  const host = (process.env.APP_BASE_URL ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "") || "zentromeet";
  const icsBody = buildIcs({
    uid: `${row.id}@${host}`,
    start: row.startAt,
    end: row.endAt,
    summary: `${row.serviceName} with ${row.staffName}`,
    description: row.meetLink
      ? `Join: ${row.meetLink}`
      : `Appointment with ${tenant.name}`,
    location: row.meetLink ?? undefined,
    organizerEmail: row.staffEmail,
    organizerName: row.staffName,
    attendeeEmail: customer.email,
    attendeeName: customer.name,
    method: row.status === "cancelled" ? "CANCEL" : "REQUEST",
  });

  // Filename: tenant-slug + short booking id. Avoids spaces + colons
  // which some Windows clients dislike on download.
  const shortId = row.id.slice(0, 8);
  const filename = `${tenant.slug}-${shortId}.ics`;

  return new NextResponse(icsBody, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
