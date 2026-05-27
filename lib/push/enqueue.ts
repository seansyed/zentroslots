/**
 * Push delivery enqueue.
 *
 * Called from booking lifecycle endpoints (POST /api/bookings,
 * /api/bookings/[id]/cancel, /api/bookings/[id]/reschedule) as
 * fire-and-forget. NEVER throws — push is enhancement, not core
 * flow. Failure to enqueue is logged but doesn't fail the booking.
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

import { db } from "@/db/client";
import { pushDeliveries, pushTokens, type bookings } from "@/db/schema";

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

function copyFor(event: PushEventType, args: EnqueueArgs): { title: string; body: string } {
  const when = formatRelativeBrief(new Date(args.booking.startAt));
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

function formatRelativeBrief(d: Date): string {
  const now = Date.now();
  const diff = d.getTime() - now;
  const absMin = Math.abs(diff) / 60_000;
  if (absMin < 60) return `${Math.round(absMin)}m`;
  const absH = absMin / 60;
  if (absH < 24) return diff > 0 ? `in ${Math.round(absH)}h` : `${Math.round(absH)}h ago`;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-US", opts).format(d);
}

/**
 * Insert one push_deliveries row per active token for the booking's
 * staff member. NEVER throws.
 */
export async function enqueueBookingPush(args: EnqueueArgs): Promise<{ enqueued: number }> {
  try {
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

    const { title, body } = copyFor(args.event, args);
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
