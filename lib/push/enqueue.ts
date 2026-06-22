/**
 * Push delivery enqueue.
 *
 * Called from the booking lifecycle as fire-and-forget:
 *   • POST /api/bookings (free path) + the paid Stripe/vault webhook
 *     (lib/billing/postBookingHooks) — booking_created
 *   • POST /api/tenant/appointments (operator create) — booking_created
 *     (notifies the ASSIGNED staff member)
 *   • /api/bookings/[id]/cancel — booking_cancelled
 *   • /api/bookings/[id]/reschedule — booking_rescheduled
 *   • scripts/send-reminders.ts (24h/2h/1h) — booking_reminder
 * NEVER throws — push is enhancement, not core flow. Failure to enqueue
 * is logged but doesn't fail the booking.
 *
 * For each event we fan out: one push_deliveries row per active
 * push_token owned by the booking's staff user. (For now, only the
 * staff member assigned to the booking gets the push — broader
 * "admins-on-call" routing is a later phase.)
 *
 * Worker picks rows up by `(status = 'pending' AND next_retry_at <= now())`
 * every minute via scripts/run-push-deliveries.ts.
 */

import { and, eq } from "drizzle-orm";

import { formatInTimeZone } from "date-fns-tz";

import { db } from "@/db/client";
import { pushDeliveries, pushTokens, users, type bookings } from "@/db/schema";
import { isDemoTenant, logDemoSuppression } from "@/lib/demo-safe";

export type PushEventType =
  | "booking_created"
  | "booking_reminder"
  | "booking_cancelled"
  | "booking_rescheduled";

type BookingRow = typeof bookings.$inferSelect;

type EnqueueArgs = {
  tenantId: string;
  booking: Pick<
    BookingRow,
    "id" | "staffUserId" | "clientName" | "startAt" | "serviceId"
  >;
  serviceName: string;
  event: PushEventType;
};

export function copyFor(event: PushEventType, args: EnqueueArgs, staffTz: string): { title: string; body: string } {
  const when = formatRelativeBrief(new Date(args.booking.startAt), staffTz);
  const who = args.booking.clientName || "A customer";
  const what = args.serviceName || "Appointment";
  switch (event) {
    case "booking_created":
      return {
        title: "New booking",
        body: `${who} booked ${what} — ${when}`,
      };
    case "booking_reminder":
      return {
        title: "Upcoming appointment",
        body: `${what} with ${who} — ${when}`,
      };
    case "booking_cancelled":
      return {
        title: "Booking cancelled",
        body: `${who} cancelled ${what} (${when})`,
      };
    case "booking_rescheduled":
      return {
        title: "Booking rescheduled",
        body: `${what} with ${who} moved to ${when}`,
      };
  }
}

export function formatRelativeBrief(d: Date, tz: string): string {
  const now = Date.now();
  const diff = d.getTime() - now;
  const absMin = Math.abs(diff) / 60_000;
  if (absMin < 60) return `${Math.round(absMin)}m`;
  const absH = absMin / 60;
  if (absH < 24) return diff > 0 ? `in ${Math.round(absH)}h` : `${Math.round(absH)}h ago`;
  // >24h out: show an ABSOLUTE time. Format it in the staff member's
  // timezone with an explicit abbreviation (zzz) so it's never an
  // unlabeled server-local/UTC time — same rule as the appointment tz fix.
  try {
    return formatInTimeZone(d, tz || "UTC", "MMM d, h:mm a zzz");
  } catch {
    return formatInTimeZone(d, "UTC", "MMM d, h:mm a zzz");
  }
}

/**
 * Insert one push_deliveries row per active token for the booking's
 * staff member. NEVER throws.
 */
export async function enqueueBookingPush(args: EnqueueArgs): Promise<{ enqueued: number }> {
  try {
    // Demo tenants never enqueue push deliveries — keeps the docs-demo
    // workspace from buzzing real devices owned by demo accounts.
    if (await isDemoTenant(args.tenantId)) {
      logDemoSuppression({
        surface: "push",
        tenantId: args.tenantId,
        context: { event: args.event, booking_id: args.booking.id },
      });
      return { enqueued: 0 };
    }

    const tokens = await db
      .select({ token: pushTokens.expoToken })
      .from(pushTokens)
      .where(
        and(
          eq(pushTokens.userId, args.booking.staffUserId),
          eq(pushTokens.tenantId, args.tenantId),
        ),
      );

    if (tokens.length === 0) return { enqueued: 0 };

    // Resolve the staff member's timezone so any absolute time in the push
    // body is rendered in their zone (not the server's). Default UTC.
    const staffRow = await db
      .select({ tz: users.timezone })
      .from(users)
      .where(eq(users.id, args.booking.staffUserId))
      .limit(1);
    const staffTz = staffRow[0]?.tz ?? "UTC";

    const { title, body } = copyFor(args.event, args, staffTz);
    const dataPayload = {
      type: args.event,
      bookingId: args.booking.id,
      tenantId: args.tenantId,
    };

    await db
      .insert(pushDeliveries)
      .values(
        tokens.map((t) => ({
          tenantId: args.tenantId,
          userId: args.booking.staffUserId,
          expoToken: t.token,
          eventType: args.event,
          bookingId: args.booking.id,
          title,
          body,
          dataPayload,
        })),
      );

    return { enqueued: tokens.length };
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: "push_enqueue_failed",
        event: args.event,
        bookingId: args.booking.id,
        err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      }),
    );
    return { enqueued: 0 };
  }
}
