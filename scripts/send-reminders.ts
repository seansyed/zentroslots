#!/usr/bin/env tsx
/**
 * send-reminders.ts
 *
 * Scans confirmed bookings whose start_at falls into the 24h, 2h, or 1h
 * window and, for each, fires the reminder EMAIL automation AND enqueues a
 * reminder PUSH to the assigned staff member, marking the booking so it
 * doesn't fire again.
 *
 * Run every 10–15 minutes via a host-level scheduler:
 *   - Windows: Task Scheduler → "npm run reminders:send" in scheduling-saas
 *   - Linux:   cron entry  *​/15 * * * *  (cd /app && npm run reminders:send)
 *
 * No queue, no daemon. Idempotent — re-running won't double-send (the
 * automation engine itself enforces DB-level idempotency, and the
 * booking's reminder_*_sent_at flag short-circuits the SELECT below).
 */

import "dotenv/config";
import { and, eq, gte, isNull, lt } from "drizzle-orm";

import { db } from "../db/client";
import { bookings, services } from "../db/schema";
import {
  triggerAutomation,
  type AutomationEvent,
} from "../lib/communications/engine";
import { adminNotify } from "../lib/admin-notify";
import { enqueueBookingPush } from "../lib/push/enqueue";

const WINDOW_MIN = 30;

async function processWindow(
  label: string,
  lo: Date,
  hi: Date,
  flag: "reminder24hSentAt" | "reminder2hSentAt" | "reminder1hSentAt",
  windowHours: 24 | 2 | 1
) {
  const reminderField =
    flag === "reminder24hSentAt" ? bookings.reminder24hSentAt :
    flag === "reminder2hSentAt" ? bookings.reminder2hSentAt :
    bookings.reminder1hSentAt;

  const due = await db
    .select({
      id: bookings.id,
      tenantId: bookings.tenantId,
      startAt: bookings.startAt,
      clientEmail: bookings.clientEmail,
      // Additive — needed to fan out the reminder PUSH to the assigned
      // staff member (enqueueBookingPush). leftJoin keeps email reminders
      // firing even if the service row was deleted (serviceName → null →
      // copyFor falls back to "Appointment").
      staffUserId: bookings.staffUserId,
      clientName: bookings.clientName,
      serviceId: bookings.serviceId,
      serviceName: services.name,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        gte(bookings.startAt, lo),
        lt(bookings.startAt, hi),
        isNull(reminderField)
      )
    )
    .limit(200);

  if (due.length === 0) return;
  console.log(`[reminders:${label}] processing ${due.length} booking(s)`);

  const eventType: AutomationEvent =
    windowHours === 24 ? "appointment.reminder_24h" :
    windowHours === 2 ? "appointment.reminder_2h" :
    "appointment.reminder_1h";

  for (const b of due) {
    // Atomically CLAIM this reminder BEFORE sending. The flag IS the claim:
    //   UPDATE ... SET flag=now() WHERE id=? AND flag IS NULL AND status='confirmed'
    // Two effects, both correctness fixes:
    //   1) Concurrency — if two cron runs overlap, only ONE claims the row
    //      (the other's UPDATE matches zero rows), so we never double-SEND.
    //      The engine's communication_logs idempotency is the backstop, but
    //      this closes the window between its pre-check and its insert.
    //   2) Status TOCTOU — re-checking status='confirmed' here means a booking
    //      cancelled/rescheduled since the SELECT above is NOT reminded.
    const claimed = await db
      .update(bookings)
      .set({ [flag]: new Date() })
      .where(and(eq(bookings.id, b.id), isNull(reminderField), eq(bookings.status, "confirmed")))
      .returning({ id: bookings.id });
    if (claimed.length === 0) continue; // already claimed by another run, or no longer confirmed

    try {
      // The engine handles: idempotency, customer pref gate, template
      // resolution (service → tenant → system), variable rendering, send,
      // and structured logging into communication_logs.
      const result = await triggerAutomation({
        tenantId: b.tenantId,
        bookingId: b.id,
        eventType,
      });

      // Reminder PUSH to the assigned staff member. Enqueued AFTER
      // triggerAutomation returns (and only on this run, which already won the
      // atomic claim above) so it fires EXACTLY ONCE per reminder window — the
      // same `reminder*SentAt` claim that dedups the email also dedups this
      // push. Placed after triggerAutomation so that if the engine THROWS (the
      // catch below RELEASES the claim for a retry) we never reach here twice.
      // enqueueBookingPush never throws and is a no-op when the staff member
      // has no push tokens / the tenant is a demo tenant. We AWAIT it because
      // the worker process.exit(0)s on completion — a fire-and-forget insert
      // could be dropped before it lands.
      await enqueueBookingPush({
        tenantId: b.tenantId,
        booking: {
          id: b.id,
          staffUserId: b.staffUserId,
          clientName: b.clientName,
          startAt: b.startAt,
          serviceId: b.serviceId,
        },
        serviceName: b.serviceName ?? "",
        event: "booking_reminder",
      });

      // The claim above already set the flag. On a provider 'failed' we
      // deliberately LEAVE it set and alert (rather than cron-retry) — the
      // failure is captured in communication_logs for admin review. (Only a
      // hard crash below releases the claim so the next tick can retry.)
      if (result.status === "failed") {
        console.error(`[reminders] send failed for ${b.id}:`, result.reason);
        // Phase 3 — admin alert on reminder delivery failure. The
        // dedupe key is the failure reason category (NOT the booking
        // id) so a systemic problem (SES sandbox, invalid sender,
        // network outage) collapses into 1 alert per cooldown
        // window instead of 1 per booking. A genuine per-booking
        // problem (rare custom-domain bounce) shows up as the next
        // reason category. This is the exact pattern that would
        // have caught the SES sandbox failures during the audit.
        const reasonCategory = (result.reason ?? "unknown").split(":")[0]?.trim() ?? "unknown";
        void adminNotify({
          kind: "reminder_delivery_failure",
          severity: "warning",
          summary: `Reminder send failed (${reasonCategory})`,
          details: result.reason ?? undefined,
          tenantId: b.tenantId,
          dedupeKey: `reminder_delivery_failure::${reasonCategory}::${b.tenantId}`,
          metadata: {
            bookingId: b.id,
            eventType,
            startAt: b.startAt.toISOString(),
            reasonCategory,
          },
        });
      }
    } catch (err) {
      // Engine threw (not a provider 'failed' result): RELEASE the claim so
      // the next cron tick can retry within the ±30min window. The engine's
      // communication_logs idempotency prevents a double-send if the throw
      // happened after the email actually went out.
      await db
        .update(bookings)
        .set({ [flag]: null })
        .where(eq(bookings.id, b.id))
        .catch(() => {});
      console.error(`[reminders] booking ${b.id} failed:`, err);
      // Phase 3 — admin alert on uncaught exception in the loop.
      // Critical severity because this means the engine itself blew
      // up (a logic bug, missing schema column, DB pool exhausted,
      // etc.) rather than the email provider returning an error
      // — that's the "failed" path above.
      void adminNotify({
        kind: "worker_crash",
        severity: "critical",
        summary: "Reminder worker uncaught exception",
        details: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        tenantId: b.tenantId,
        dedupeKey: `reminder_worker_crash::${b.tenantId}`,
        metadata: { bookingId: b.id, eventType },
      });
    }
  }
}

async function main() {
  const now = new Date();
  const m = (mins: number) => new Date(now.getTime() + mins * 60_000);

  await processWindow("24 hours away", m(24 * 60 - WINDOW_MIN), m(24 * 60 + WINDOW_MIN), "reminder24hSentAt", 24);
  // 2h window [90,150) min and 1h window [30,90) min are adjacent — no overlap
  // (each gte(lo)/lt(hi)), and each has its own *SentAt claim flag, so a booking
  // gets the 2h then the 1h reminder exactly once each.
  await processWindow("2 hours away",  m(2 * 60 - WINDOW_MIN),   m(2 * 60 + WINDOW_MIN),   "reminder2hSentAt",  2);
  await processWindow("1 hour away",   m(60 - WINDOW_MIN),       m(60 + WINDOW_MIN),       "reminder1hSentAt",  1);
  console.log("[reminders] done");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
