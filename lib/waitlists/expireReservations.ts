/**
 * Sweep stale 'sent' notifications past their expiresAt.
 *
 * Runs from scripts/expire-waitlist-reservations.ts on a cron cadence.
 *
 * For each expired notification:
 *   1. Mark the notification 'expired'
 *   2. Resurrect the waitlist row to 'waiting' so it can be re-promoted
 *   3. Attempt to re-release that slot to the next-best candidate
 *      (best-effort — if no one matches, the slot stays freed and the
 *      next booking-cancel will trigger another release attempt)
 *
 * Idempotent: re-running over already-expired rows is a no-op.
 */
import { and, eq, lte } from "drizzle-orm";

import { db } from "@/db/client";
import { waitlists, waitlistNotifications } from "@/db/schema";

import { releaseSlot } from "./releaseSlot";

export type ExpireRunResult = {
  scanned: number;
  expired: number;
  rePromoted: number;
};

const BATCH_SIZE = 100;

export async function expireReservations(): Promise<ExpireRunResult> {
  const now = new Date();

  // 1. Find expired-but-not-yet-flipped rows.
  const stale = await db
    .select()
    .from(waitlistNotifications)
    .where(
      and(
        eq(waitlistNotifications.status, "sent"),
        lte(waitlistNotifications.expiresAt, now)
      )
    )
    .limit(BATCH_SIZE);

  let expired = 0;
  let rePromoted = 0;

  for (const n of stale) {
    try {
      // 2. Flip notification to expired AND waitlist back to waiting
      //    in one tx — never leave the queue in a half-state.
      await db.transaction(async (tx) => {
        const flipped = await tx
          .update(waitlistNotifications)
          .set({ status: "expired", respondedAt: now })
          .where(
            and(
              eq(waitlistNotifications.id, n.id),
              eq(waitlistNotifications.status, "sent")
            )
          )
          .returning();
        if (flipped.length === 0) return; // race — someone claimed in flight

        await tx
          .update(waitlists)
          .set({ status: "waiting", expiresAt: null, updatedAt: now })
          .where(
            and(
              eq(waitlists.id, n.waitlistId),
              eq(waitlists.status, "notified")
            )
          );
        expired++;
      });

      // 3. Try to re-release this slot to the next candidate. The
      //    slot is the one stored on the notification row.
      if (n.staffUserId && n.slotStartAt && n.slotEndAt) {
        const result = await releaseSlot({
          tenantId: n.tenantId,
          serviceId: (
            await db.query.waitlists.findFirst({ where: eq(waitlists.id, n.waitlistId) })
          )?.serviceId ?? "",
          staffUserId: n.staffUserId,
          slotStartAt: n.slotStartAt,
          slotEndAt: n.slotEndAt,
          originatingBookingId: n.bookingId,
        });
        if (result.ok) rePromoted++;
      }
    } catch (e) {
      console.error(`[waitlists] expire row ${n.id} crashed:`, e);
    }
  }

  return { scanned: stale.length, expired, rePromoted };
}
