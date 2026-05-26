#!/usr/bin/env tsx
/**
 * expire-payment-holds.ts — Stabilization Wave hardening.
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
 *
 * Stabilization Wave additions (additive — no behavior change in the
 * happy path):
 *   1. withCronRun() observability — every tick lands a row in
 *      cron_runs so the diagnostics panel can show last-run state.
 *   2. Backlog admin-notify — if any candidate row is overdue by >10
 *      minutes (i.e. the cron has been missing or the prior run
 *      failed), fire a `payment_hold_backlog` admin alert. The
 *      cooldown layer in admin-notify dedupes to one email/hour.
 *   3. Structured stdout JSON for log aggregators.
 */

import "dotenv/config";

import { and, eq, lt, sql } from "drizzle-orm";

import { db } from "../db/client";
import { bookings } from "../db/schema";
import { audit } from "../lib/audit";
import { adminNotify } from "../lib/admin-notify";
import { withCronRun } from "../lib/cronObservability";

const STALE_THRESHOLD_MIN = Number(process.env.HOLDS_BACKLOG_THRESHOLD_MIN ?? 10);

(async () => {
  try {
    await withCronRun("holds:expire", async (ctx) => {
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

      // Detect stale backlog (rows overdue by > threshold) — signals
      // the cron has been silent. Best-effort admin-notify; failure
      // here MUST NOT block the actual cleanup work.
      const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MIN * 60_000);
      const stale = expired.filter(
        (b) => b.paymentHoldExpiresAt !== null && b.paymentHoldExpiresAt < staleCutoff,
      );
      if (stale.length > 0) {
        try {
          const oldestOverdueMs = Math.max(
            ...stale.map(
              (b) => now.getTime() - (b.paymentHoldExpiresAt?.getTime() ?? now.getTime()),
            ),
          );
          await adminNotify({
            kind: "payment_hold_backlog",
            severity: stale.length >= 10 ? "critical" : "warning",
            summary: `${stale.length} payment hold${stale.length === 1 ? "" : "s"} overdue >${STALE_THRESHOLD_MIN}min — cron possibly silent`,
            details:
              "The expire-payment-holds cron found bookings whose payment_hold_expires_at " +
              `is more than ${STALE_THRESHOLD_MIN} minutes in the past. Either the cron was ` +
              "previously not scheduled, or recent runs failed. Inspect cron_runs for the most " +
              "recent successful tick of job_name='holds:expire'.",
            metadata: {
              total_candidates: expired.length,
              stale_candidates: stale.length,
              oldest_overdue_hours: Math.round((oldestOverdueMs / 3_600_000) * 10) / 10,
              threshold_min: STALE_THRESHOLD_MIN,
            },
          });
        } catch (err) {
          console.error(
            JSON.stringify({
              evt: "holds.admin_notify_fail",
              reason: err instanceof Error ? err.message.slice(0, 200) : "unknown",
            }),
          );
        }
      }

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

      ctx.detail({
        candidates: expired.length,
        ok,
        failed,
        stale_candidates: stale.length,
      });

      console.log(
        `[holds] candidates=${expired.length} ok=${ok} failed=${failed} stale=${stale.length}`
      );
    });
    process.exit(0);
  } catch (e) {
    console.error("[holds] worker crashed:", e);
    process.exit(1);
  }
})();
