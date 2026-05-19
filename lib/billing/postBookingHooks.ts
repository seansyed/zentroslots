/**
 * Post-booking-confirmation hooks. Shared between the free-path inline
 * flow (POST /api/bookings) and the paid-path webhook flow
 * (Stripe checkout.session.completed → confirmPendingPaymentBooking).
 *
 * Every step wraps in its own try/catch — a single failure (Google
 * Calendar down, email provider stub, etc.) NEVER blocks the others.
 * Mirrors the original inline flow so behavior stays byte-identical
 * for free bookings.
 */

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, users, type Booking } from "@/db/schema";
import { onBookingCreated } from "@/lib/calendar/sync";
import { triggerAutomation } from "@/lib/communications/engine";
import { upsertCustomer } from "@/lib/customers";
import { loadTenantFeatures } from "@/lib/features";

export async function runPostConfirmationHooks(args: {
  bookingId: string;
  tenantId: string;
}): Promise<void> {
  let row: Booking | undefined;
  try {
    row = await db.query.bookings.findFirst({ where: eq(bookings.id, args.bookingId) });
  } catch (err) {
    console.error("[post-hooks] booking lookup failed:", err);
    return;
  }
  if (!row || row.tenantId !== args.tenantId) return;

  // Load related rows we'll need.
  let service: typeof services.$inferSelect | undefined;
  let staff: typeof users.$inferSelect | undefined;
  try {
    [service, staff] = await Promise.all([
      db.query.services.findFirst({ where: eq(services.id, row.serviceId) }),
      db.query.users.findFirst({ where: eq(users.id, row.staffUserId) }),
    ]);
  } catch (err) {
    console.error("[post-hooks] related lookup failed:", err);
  }
  if (!service || !staff) return;

  const features = await loadTenantFeatures(args.tenantId).catch(() => null);
  const wantMeet =
    service.videoProvider === "google_meet" && features?.googleMeet === true;

  // ── Calendar sync ─────────────────────────────────────────────
  try {
    const result = await onBookingCreated({
      booking: row,
      staff,
      serviceName: service.name,
      videoConference: wantMeet,
    });
    if (result.status === "ok" && result.eventId) {
      await db
        .update(bookings)
        .set({
          googleEventId: result.eventId,
          externalEventId: result.eventId,
          externalEventProvider: "google",
          meetLink: result.meetLink ?? row.meetLink,
        })
        .where(eq(bookings.id, row.id));
    }
  } catch (err) {
    console.error("[post-hooks] calendar sync failed:", err);
  }

  // ── Confirmation email ───────────────────────────────────────
  try {
    await triggerAutomation({
      tenantId: args.tenantId,
      bookingId: row.id,
      eventType: "appointment.created",
      attachIcs: true,
    });
  } catch (err) {
    console.error("[post-hooks] confirmation automation failed:", err);
  }

  // ── Customer upsert ──────────────────────────────────────────
  try {
    const customerId = await upsertCustomer({
      tenantId: args.tenantId,
      name: row.clientName,
      email: row.clientEmail,
    });
    if (customerId) {
      await db.update(bookings).set({ customerId }).where(eq(bookings.id, row.id));
    }
  } catch (err) {
    console.error("[post-hooks] customer upsert failed:", err);
  }
}
