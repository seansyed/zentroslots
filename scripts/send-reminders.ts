#!/usr/bin/env tsx
/**
 * send-reminders.ts
 *
 * Scans confirmed bookings whose start_at falls into the 24h or 1h
 * window and sends one reminder email each, marking the booking so
 * it doesn't fire again.
 *
 * Run every 10–15 minutes via a host-level scheduler:
 *   - Windows: Task Scheduler → "npm run reminders:send" in scheduling-saas
 *   - Linux:   cron entry  *​/15 * * * *  (cd /app && npm run reminders:send)
 *
 * No queue, no daemon. Idempotent — re-running won't double-send.
 */

import "dotenv/config";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";

import { db } from "../db/client";
import { bookings, customers, services, tenants, users } from "../db/schema";
import { signBookingToken } from "../lib/tokens";
import { renderReminder, sendEmail, type BookingForEmail } from "../lib/email";
import { normalizePrefs, shouldSendEmailReminder } from "../lib/client-prefs";

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
      endAt: bookings.endAt,
      clientName: bookings.clientName,
      clientEmail: bookings.clientEmail,
      meetLink: bookings.meetLink,
      serviceId: bookings.serviceId,
      staffUserId: bookings.staffUserId,
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

  for (const b of due) {
    try {
      const [svc, staff, tenant, customer] = await Promise.all([
        db.query.services.findFirst({ where: eq(services.id, b.serviceId) }),
        db.query.users.findFirst({ where: eq(users.id, b.staffUserId) }),
        db.query.tenants.findFirst({ where: eq(tenants.id, b.tenantId) }),
        // Tenant-scoped, case-insensitive email match. May be null if
        // the booking was created before a customer record existed.
        db.query.customers.findFirst({
          where: and(
            eq(customers.tenantId, b.tenantId),
            sql`lower(${customers.email}) = lower(${b.clientEmail})`
          ),
        }),
      ]);
      if (!svc || !staff || !tenant) continue;

      // Honor per-customer preferences. Customers who haven't visited
      // their portal have no record yet → DEFAULT_PREFS (everything on)
      // applies via normalizePrefs(undefined).
      const prefs = normalizePrefs(customer?.commPrefs);
      if (!shouldSendEmailReminder(prefs, windowHours)) {
        // Mark the flag so the cron doesn't keep looking at this row;
        // the customer opted out of this reminder, that's a final no.
        await db
          .update(bookings)
          .set({ [flag]: new Date() })
          .where(eq(bookings.id, b.id));
        console.log(`[reminders:${label}] skipped ${b.id} — disabled by customer prefs`);
        continue;
      }

      const [cancelToken, rescheduleToken] = await Promise.all([
        signBookingToken({ bookingId: b.id, tenantId: b.tenantId, kind: "cancel" }),
        signBookingToken({ bookingId: b.id, tenantId: b.tenantId, kind: "reschedule" }),
      ]);
      const payload: BookingForEmail = {
        id: b.id,
        serviceName: svc.name,
        staffName: staff.name,
        staffEmail: staff.email,
        startAt: b.startAt,
        endAt: b.endAt,
        clientName: b.clientName,
        clientEmail: b.clientEmail,
        clientTimezone: staff.timezone,
        meetLink: b.meetLink,
        tenantName: tenant.name,
        cancelToken,
        rescheduleToken,
      };
      const tpl = renderReminder(payload, label);

      const result = await sendEmail({ to: b.clientEmail, ...tpl });
      if (result.ok) {
        await db
          .update(bookings)
          .set({ [flag]: new Date() })
          .where(eq(bookings.id, b.id));
      } else {
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
