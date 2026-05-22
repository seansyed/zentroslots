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
  // Wave C.1 — Teams services share the `googleMeet` tenant feature
  // flag (which is really "auto-create a video link"). Both providers
  // are video; the flag name is a Wave A artifact we can rename in a
  // future cleanup wave.
  const wantVideo =
    (service.videoProvider === "google_meet" || service.videoProvider === "teams") &&
    features?.googleMeet === true;

  // ── Calendar sync ─────────────────────────────────────────────
  // Wave C.1 — orchestrator now returns the provider it actually
  // dispatched to; we mirror that onto the booking row instead of
  // hardcoding "google". `googleEventId` only populates for Google
  // events so legacy readers keep working; for Microsoft events the
  // canonical id lives on `externalEventId` + `externalEventProvider`.
  try {
    const result = await onBookingCreated({
      booking: row,
      staff,
      serviceName: service.name,
      videoConference: wantVideo,
      videoProviderHint: service.videoProvider,
    });
    if (result.status === "ok" && result.eventId) {
      await db
        .update(bookings)
        .set({
          googleEventId: result.provider === "google" ? result.eventId : null,
          externalEventId: result.eventId,
          externalEventProvider: result.provider,
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
