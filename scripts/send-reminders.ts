#!/usr/bin/env tsx
/**
 * send-reminders.ts
 *
 * Scans confirmed bookings whose start_at falls into the 24h or 1h
 * window and fires a reminder automation each, marking the booking so
 * it doesn't fire again.
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
import { bookings } from "../db/schema";
import {
  triggerAutomation,
  type AutomationEvent,
} from "../lib/communications/engine";

const WINDOW_MIN = 30;

async function processWindow(
  label: string,
  lo: Date,
  hi: Date,
  flag: "reminder24hSentAt" | "reminder1hSentAt",
  windowHours: 24 | 1
) {
  const reminderField =
    flag === "reminder24hSentAt" ? bookings.reminder24hSentAt : bookings.reminder1hSentAt;

  const due = await db
    .select({
      id: bookings.id,
      tenantId: bookings.tenantId,
      startAt: bookings.startAt,
      clientEmail: bookings.clientEmail,
    })
    .from(bookings)
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
    windowHours === 24 ? "appointment.reminder_24h" : "appointment.reminder_1h";

  for (const b of due) {
    try {
      // The engine handles: idempotency, customer pref gate, template
      // resolution (service → tenant → system), variable rendering, send,
      // and structured logging into communication_logs.
      const result = await triggerAutomation({
        tenantId: b.tenantId,
        bookingId: b.id,
        eventType,
      });

      // Whatever the engine decided (sent / skipped / failed), we mark
      // the booking's flag so cron stops looking at this row. Skipped =
      // customer opted out; we don't keep retrying that. Failed = log is
      // already in communication_logs for admin review; retrying via
      // cron isn't the right recovery vector (admins can manually
      // re-fire later from the delivery log UI in a future session).
      await db
        .update(bookings)
        .set({ [flag]: new Date() })
        .where(eq(bookings.id, b.id));

      if (result.status === "failed") {
        console.error(`[reminders] send failed for ${b.id}:`, result.reason);
      }
    } catch (err) {
      console.error(`[reminders] booking ${b.id} failed:`, err);
    }
  }
}

async function main() {
  const now = new Date();
  const m = (mins: number) => new Date(now.getTime() + mins * 60_000);

  await processWindow("24 hours away", m(24 * 60 - WINDOW_MIN), m(24 * 60 + WINDOW_MIN), "reminder24hSentAt", 24);
  await processWindow("1 hour away",   m(60 - WINDOW_MIN),       m(60 + WINDOW_MIN),       "reminder1hSentAt",  1);
  console.log("[reminders] done");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
