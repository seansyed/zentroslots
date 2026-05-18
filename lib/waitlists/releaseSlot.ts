/**
 * Slot-release orchestrator.
 *
 * Called from cancel + reschedule routes after a booking is freed.
 * Finds the best-fit waitlist candidate, atomically transitions
 * them to 'notified', creates a reservation hold, and queues a
 * slot_available email via triggerAutomation.
 *
 * Fairness contract:
 *   - At most ONE active 'sent' notification per waitlist row at a
 *     time (DB partial unique index).
 *   - The atomic UPDATE waitlists SET status='notified' WHERE
 *     status='waiting' ensures only one orchestrator wins if two
 *     bookings get cancelled in parallel and both try the same
 *     candidate.
 *
 * NEVER throws. Lifecycle ops (cancel/reschedule) wrap in try/catch
 * but rule #13 demands the orchestrator itself can't take down a
 * cancel.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  users,
  waitlists,
  waitlistNotifications,
} from "@/db/schema";

import { hourToRange, pickBest, rankCandidate, type CandidateRank } from "./matching";
import { DEFAULT_RESERVATION_MINUTES, type WaitlistTimeRange } from "./types";
import { buildClaimUrl, signWaitlistClaimToken } from "./tokens";

export type ReleaseSlotInput = {
  tenantId: string;
  serviceId: string;
  staffUserId: string;
  /** Slot window that just opened. */
  slotStartAt: Date;
  slotEndAt: Date;
  /** Booking that was cancelled/rescheduled (for audit metadata). */
  originatingBookingId?: string | null;
};

export type ReleaseSlotResult =
  | {
      ok: true;
      waitlistId: string;
      notificationId: string;
      claimUrl: string;
      expiresAt: Date;
      customerEmail: string;
    }
  | { ok: false; reason: string };

export async function releaseSlot(input: ReleaseSlotInput): Promise<ReleaseSlotResult> {
  try {
    // 1. Resolve staff TZ for date/hour bucketing.
    const staff = await db.query.users.findFirst({
      where: eq(users.id, input.staffUserId),
    });
    if (!staff) return { ok: false, reason: "staff_missing" };

    const tz = staff.timezone ?? "UTC";
    const slotDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(input.slotStartAt);
    const slotHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit",
        hour12: false,
      }).format(input.slotStartAt)
    );

    // 2. Pull all WAITING candidates for this (tenant, service).
    const candidates = await db
      .select()
      .from(waitlists)
      .where(
        and(
          eq(waitlists.tenantId, input.tenantId),
          eq(waitlists.serviceId, input.serviceId),
          eq(waitlists.status, "waiting")
        )
      );
    if (candidates.length === 0) return { ok: false, reason: "no_waiters" };

    // 3. Rank + pick best. Pure logic — testable.
    const ranked = candidates.map((c) => ({
      preferredDate: c.preferredDate,
      preferredTimeRange: c.preferredTimeRange as WaitlistTimeRange,
      rank: rankCandidate(
        { preferredDate: c.preferredDate, preferredTimeRange: c.preferredTimeRange as WaitlistTimeRange },
        { date: slotDate, hour: slotHour }
      ) as CandidateRank,
      priority: c.priority,
      createdAt: c.createdAt,
      _row: c,
    }));
    const winner = pickBest(ranked);
    if (!winner) return { ok: false, reason: "no_eligible_match" };

    const winnerRow = (winner as typeof ranked[number])._row;
    const expiresAt = new Date(Date.now() + DEFAULT_RESERVATION_MINUTES * 60_000);

    // 4. Atomically claim the candidate: flip status only if STILL
    // 'waiting'. Returns 0 rows if another orchestrator (or admin
    // manual promote) already moved them.
    const flipped = await db
      .update(waitlists)
      .set({
        status: "notified",
        expiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(waitlists.id, winnerRow.id),
          eq(waitlists.status, "waiting")
        )
      )
      .returning();
    if (flipped.length === 0) {
      // Race — another open slot beat us. Move on; the cron will
      // pick the next candidate when this notification eventually
      // gets attached to its slot.
      return { ok: false, reason: "race_lost" };
    }

    // 5. Insert the notification row. The partial unique index
    // protects against parallel offers to the same waitlist row.
    let notif: typeof waitlistNotifications.$inferSelect;
    try {
      [notif] = await db
        .insert(waitlistNotifications)
        .values({
          tenantId: input.tenantId,
          waitlistId: winnerRow.id,
          bookingId: input.originatingBookingId ?? null,
          notificationType: "slot_available",
          status: "sent",
          staffUserId: input.staffUserId,
          slotStartAt: input.slotStartAt,
          slotEndAt: input.slotEndAt,
          expiresAt,
        })
        .returning();
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === "23505") {
        // Already has an outstanding notification — flip status back
        // to 'waiting' so the queue doesn't get stuck. The cron will
        // sweep stale 'notified' rows that have no live notification.
        await db
          .update(waitlists)
          .set({ status: "waiting", updatedAt: new Date() })
          .where(eq(waitlists.id, winnerRow.id));
        return { ok: false, reason: "already_notified" };
      }
      throw e;
    }

    // 6. Sign the claim token. Token expiry matches the reservation
    // expiry exactly. The server-side claim handler ALSO validates
    // the row's expires_at — defense in depth.
    const claimToken = await signWaitlistClaimToken(
      {
        notificationId: notif.id,
        waitlistId: winnerRow.id,
        tenantId: input.tenantId,
      },
      expiresAt
    );
    const claimUrl = buildClaimUrl(claimToken);

    return {
      ok: true,
      waitlistId: winnerRow.id,
      notificationId: notif.id,
      claimUrl,
      expiresAt,
      customerEmail: winnerRow.customerEmail,
    };
  } catch (e) {
    console.error("[waitlists] releaseSlot orchestrator failed:", e);
    return { ok: false, reason: "orchestrator_error" };
  }
}

// _ reserved
void sql;
