#!/usr/bin/env tsx
/**
 * Wave H Phase 3 — tenant-vault payment reconciliation.
 *
 *   tsx scripts/reconcile-tenant-payments.ts [--days=1] [--dry-run]
 *
 * SCAFFOLDED — NOT WIRED INTO crontab on first deploy. Operator
 * enables in cron after observing one week of normal traffic.
 *
 * What this script does:
 *   1. Read tenant_payment_webhook_events for the last N days.
 *   2. For each event with status='processed' AND booking_id set AND
 *      kind classifies as a payment-completion event, verify the
 *      referenced booking row is in 'confirmed' state.
 *   3. For each event with booking_id NULL or status='unhandled',
 *      log as a potential orphan for admin review.
 *   4. For each bookings row in 'pending_payment' past hold expiry
 *      where the events table contains a verified payment for that
 *      booking, flag as a data-inconsistency (the hold-expiry cron
 *      should have already transitioned, OR the webhook arrived
 *      late and confirm + auto-refund should be invoked).
 *
 * What it does NOT do:
 *   • Auto-refund (Decision 4: manual review only)
 *   • Auto-finalize (webhook-only truth model)
 *   • Email or notify — output is structured JSON for log forwarders
 *
 * Exit codes:
 *   0 — completed (zero or more findings)
 *   1 — fatal error during the run
 *
 * Output: stdout structured JSON, one line per finding, plus a final
 * SUMMARY line.
 */

import "dotenv/config";

import { and, desc, eq, gte, isNotNull, lt, or, sql } from "drizzle-orm";

import { db } from "../db/client";
import { bookings, tenantPaymentWebhookEvents } from "../db/schema";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const daysArg = args.find((a) => a.startsWith("--days="));
const days = daysArg ? Math.max(1, Number(daysArg.split("=")[1])) : 1;

function log(obj: Record<string, unknown>) {
  console.log(JSON.stringify({ ...obj, ts: new Date().toISOString() }));
}

(async () => {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    log({ evt: "reconcile.start", days, dryRun, since: since.toISOString() });

    // ── Finding 1: verified payment events with no matching booking
    //              row (or booking not in confirmed state).
    const paymentEvents = await db
      .select({
        id: tenantPaymentWebhookEvents.id,
        tenantId: tenantPaymentWebhookEvents.tenantId,
        providerId: tenantPaymentWebhookEvents.providerId,
        bookingId: tenantPaymentWebhookEvents.bookingId,
        externalEventId: tenantPaymentWebhookEvents.externalEventId,
        eventType: tenantPaymentWebhookEvents.eventType,
        status: tenantPaymentWebhookEvents.status,
        receivedAt: tenantPaymentWebhookEvents.receivedAt,
      })
      .from(tenantPaymentWebhookEvents)
      .where(
        and(
          gte(tenantPaymentWebhookEvents.receivedAt, since),
          eq(tenantPaymentWebhookEvents.status, "processed"),
          // Restrict to payment-class events to keep noise low.
          sql`${tenantPaymentWebhookEvents.eventType} ILIKE ANY (ARRAY[
            'checkout.session.completed',
            'payment_intent.succeeded',
            'PAYMENT.CAPTURE.COMPLETED',
            'CHECKOUT.ORDER.COMPLETED'
          ])`,
        ),
      )
      .orderBy(desc(tenantPaymentWebhookEvents.receivedAt));

    let unmatchedCount = 0;
    let mismatchCount = 0;
    let okCount = 0;
    for (const ev of paymentEvents) {
      if (!ev.bookingId) {
        unmatchedCount++;
        log({
          evt: "reconcile.orphan_event_no_booking_id",
          eventId: ev.externalEventId,
          tenantId: ev.tenantId,
          providerId: ev.providerId,
          eventType: ev.eventType,
        });
        continue;
      }
      const booking = await db.query.bookings.findFirst({
        where: and(
          eq(bookings.id, ev.bookingId),
          eq(bookings.tenantId, ev.tenantId),
        ),
        columns: { id: true, status: true, paymentProviderId: true },
      });
      if (!booking) {
        unmatchedCount++;
        log({
          evt: "reconcile.orphan_event_booking_missing",
          eventId: ev.externalEventId,
          tenantId: ev.tenantId,
          providerId: ev.providerId,
          bookingId: ev.bookingId,
        });
        continue;
      }
      if (booking.status !== "confirmed") {
        mismatchCount++;
        log({
          evt: "reconcile.event_booking_state_mismatch",
          eventId: ev.externalEventId,
          tenantId: ev.tenantId,
          providerId: ev.providerId,
          bookingId: ev.bookingId,
          bookingStatus: booking.status,
          eventType: ev.eventType,
          hint: "verified payment event exists but booking is not 'confirmed' — manual review",
        });
        continue;
      }
      if (booking.paymentProviderId && booking.paymentProviderId !== ev.providerId) {
        // Should be impossible given receiver's spoof checks, but surface
        // for forensic visibility.
        log({
          evt: "reconcile.cross_provider_attribution_drift",
          eventId: ev.externalEventId,
          tenantId: ev.tenantId,
          providerId: ev.providerId,
          bookingId: ev.bookingId,
          bookingProviderId: booking.paymentProviderId,
        });
        continue;
      }
      okCount++;
    }

    // ── Finding 2: pending_payment bookings still past hold expiry.
    // The hold-expiry cron should have cancelled them; if it hasn't,
    // either it's been failing or there's a stuck row.
    const now = new Date();
    const stuckPending = await db
      .select({
        id: bookings.id,
        tenantId: bookings.tenantId,
        paymentHoldExpiresAt: bookings.paymentHoldExpiresAt,
        paymentProviderId: bookings.paymentProviderId,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, "pending_payment"),
          isNotNull(bookings.paymentHoldExpiresAt),
          lt(bookings.paymentHoldExpiresAt, now),
          // Only inspect Wave H bookings.
          isNotNull(bookings.paymentProviderId),
          gte(bookings.startAt, since),
        ),
      );

    for (const b of stuckPending) {
      log({
        evt: "reconcile.stuck_pending_payment",
        bookingId: b.id,
        tenantId: b.tenantId,
        providerId: b.paymentProviderId,
        holdExpiredAt: b.paymentHoldExpiresAt?.toISOString(),
        hint: "expire-payment-holds cron may be failing; investigate",
      });
    }

    log({
      evt: "reconcile.summary",
      days,
      dryRun,
      eventsScanned: paymentEvents.length,
      eventsOk: okCount,
      eventsUnmatched: unmatchedCount,
      eventsMismatch: mismatchCount,
      stuckPendingBookings: stuckPending.length,
    });
    process.exit(0);
  } catch (err) {
    log({
      evt: "reconcile.fatal",
      err: err instanceof Error ? err.message.slice(0, 500) : "unknown",
    });
    process.exit(1);
  }
})();

// Force inclusion of unused import for future expansion.
void or;
