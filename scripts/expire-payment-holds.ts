#!/usr/bin/env tsx
/**
 * expire-payment-holds.ts
 *
 * Finds bookings in 'pending_payment' state whose payment_hold_expires_at
 * is in the past and transitions them to 'cancelled'. This releases the
 * soft hold (the secondary partial unique index no longer applies) and
 * the slot becomes available for a new pending_payment or confirmed
 * booking.
 *
 *   Linux cron:  every 5 minutes  -- "* /5 * * * *" (cd /app && npm run holds:expire)
 *
 * Per-row try/catch so one bad booking can't stall the batch.
 * Tenant-isolated by definition: the UPDATE is keyed on booking id.
 * Audits each expiry as booking.payment_hold_expired (additive action).
 * Idempotent: re-running picks up the same rows only if the update
 * crashed mid-flight (rare).
 */

import "dotenv/config";

import { and, eq, lt } from "drizzle-orm";

import { db } from "../db/client";
import { bookings } from "../db/schema";
import { audit } from "../lib/audit";

(async () => {
  try {
    const now = new Date();
    const expired = await db
      .select({
        id: bookings.id,
        tenantId: bookings.tenantId,
        startAt: bookings.startAt,
        clientEmail: bookings.clientEmail,
        paymentHoldExpiresAt: bookings.paymentHoldExpiresAt,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, "pending_payment"),
          lt(bookings.paymentHoldExpiresAt, now)
        )
      );

    let ok = 0;
    let failed = 0;
    for (const b of expired) {
      try {
        await db
          .update(bookings)
          .set({
            status: "cancelled",
            paymentHoldExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(bookings.id, b.id),
              eq(bookings.status, "pending_payment") // race guard
            )
          );
        audit({
          tenantId: b.tenantId,
          action: "booking.payment_hold_expired",
          entityType: "booking",
          entityId: b.id,
          metadata: {
            hold_expired_at: b.paymentHoldExpiresAt?.toISOString() ?? null,
            start_at: b.startAt.toISOString(),
            client_email_domain: b.clientEmail.split("@")[1] ?? "?",
          },
        });
        ok++;
      } catch (err) {
        failed++;
        console.error(
          JSON.stringify({
            evt: "payment_hold_expire_failed",
            booking_id: b.id,
            tenant_id: b.tenantId,
            err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            ts: new Date().toISOString(),
          })
        );
      }
    }

    console.log(
      `[holds] candidates=${expired.length} ok=${ok} failed=${failed}`
    );
    process.exit(0);
  } catch (e) {
    console.error("[holds] worker crashed:", e);
    process.exit(1);
  }
})();
