/**
 * Claim a reserved waitlist slot.
 *
 * Verifies the token, checks the notification is still 'sent' and
 * not yet expired, then INSERTs a real booking. The booking insert
 * goes through the same path as any other booking — the EXCLUDE
 * constraint is still authoritative (rule #2). If a concurrent
 * booking grabbed the slot in the meantime, we surface a friendly
 * "slot no longer available" error and let the customer rejoin.
 *
 * Atomicity:
 *   - Verify reservation under SELECT FOR UPDATE if available
 *   - Insert booking
 *   - Flip notification → 'claimed', waitlist → 'claimed'
 *
 * Drizzle ORM transactions wrap the whole thing so a mid-flow crash
 * doesn't leave the queue half-flipped.
 */
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  services,
  users,
  waitlists,
  waitlistNotifications,
} from "@/db/schema";

import { verifyWaitlistClaimToken } from "./tokens";

export type ClaimInput = {
  token: string;
};

export type ClaimResult =
  | { ok: true; bookingId: string; meetLink: string | null }
  | {
      ok: false;
      reason:
        | "invalid_token"
        | "expired"
        | "already_claimed"
        | "not_found"
        | "slot_taken"
        | "engine_error";
      message: string;
    };

export async function claimReservation(input: ClaimInput): Promise<ClaimResult> {
  const payload = await verifyWaitlistClaimToken(input.token);
  if (!payload) {
    return { ok: false, reason: "invalid_token", message: "This claim link is invalid or has expired." };
  }

  try {
    const notif = await db.query.waitlistNotifications.findFirst({
      where: and(
        eq(waitlistNotifications.id, payload.notificationId),
        eq(waitlistNotifications.tenantId, payload.tenantId)
      ),
    });
    if (!notif) {
      return { ok: false, reason: "not_found", message: "We couldn't find that reservation." };
    }
    if (notif.status === "claimed") {
      return { ok: false, reason: "already_claimed", message: "This reservation has already been claimed." };
    }
    if (notif.status !== "sent" || notif.expiresAt.getTime() < Date.now()) {
      return {
        ok: false,
        reason: "expired",
        message: "This reservation has expired. You can rejoin the waitlist to try again.",
      };
    }
    if (!notif.staffUserId || !notif.slotStartAt || !notif.slotEndAt) {
      return { ok: false, reason: "not_found", message: "This reservation is missing slot details." };
    }

    const waitlistRow = await db.query.waitlists.findFirst({
      where: and(
        eq(waitlists.id, payload.waitlistId),
        eq(waitlists.tenantId, payload.tenantId)
      ),
    });
    if (!waitlistRow) {
      return { ok: false, reason: "not_found", message: "We couldn't find your waitlist entry." };
    }

    const service = await db.query.services.findFirst({
      where: eq(services.id, waitlistRow.serviceId),
    });
    const staff = await db.query.users.findFirst({
      where: eq(users.id, notif.staffUserId),
    });
    if (!service || !staff) {
      return { ok: false, reason: "not_found", message: "Service or staff is no longer available." };
    }

    // Transactional insert + state flip. If the EXCLUDE constraint
    // throws (another booking grabbed the slot), the whole transaction
    // rolls back AND we surface a friendly message.
    let bookingId: string;
    let meetLink: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(bookings)
          .values({
            tenantId: payload.tenantId,
            serviceId: service.id,
            staffUserId: staff.id,
            clientName: waitlistRow.customerName,
            clientEmail: waitlistRow.customerEmail,
            startAt: notif.slotStartAt!,
            endAt: notif.slotEndAt!,
            status: "confirmed",
            assignmentMode: "auto",
            notes: "Booked from waitlist",
          })
          .returning();
        bookingId = row.id;
        meetLink = row.meetLink;

        // Mark notification + waitlist as claimed in the same tx.
        await tx
          .update(waitlistNotifications)
          .set({
            status: "claimed",
            respondedAt: new Date(),
          })
          .where(eq(waitlistNotifications.id, notif.id));
        await tx
          .update(waitlists)
          .set({
            status: "claimed",
            claimedAt: new Date(),
            claimedBookingId: row.id,
            updatedAt: new Date(),
          })
          .where(eq(waitlists.id, waitlistRow.id));
      });
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "23P01") {
        // Slot lost to a concurrent booking — flip notification expired
        // and leave the waitlist row at 'notified' so the cron rescues
        // it (next-candidate promotion).
        await db
          .update(waitlistNotifications)
          .set({ status: "expired", respondedAt: new Date() })
          .where(eq(waitlistNotifications.id, notif.id));
        return {
          ok: false,
          reason: "slot_taken",
          message: "That slot was just booked by someone else. You can rejoin the waitlist.",
        };
      }
      throw e;
    }

    return { ok: true, bookingId: bookingId!, meetLink };
  } catch (e) {
    console.error("[waitlists] claimReservation failed:", e);
    return { ok: false, reason: "engine_error", message: "Something went wrong claiming this slot." };
  }
}
