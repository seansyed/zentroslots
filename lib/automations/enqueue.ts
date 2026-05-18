/**
 * Enqueue helper for delayed automations.
 *
 * Writes to `pending_automations` with a due_at calculated from
 * delayMinutes. The unique partial index on (booking_id, event_type)
 * WHERE status IN ('pending','processing') prevents accidental
 * double-enqueues; we swallow the 23505 race silently.
 *
 * NEVER throws to the caller — booking lifecycle is not allowed to
 * fail because an automation enqueue failed (rule #13).
 */
import { db } from "@/db/client";
import { pendingAutomations } from "@/db/schema";

import type { FollowupTriggerEvent } from "./types";

export type EnqueueArgs = {
  tenantId: string;
  bookingId: string;
  /** Mirrors AutomationEvent string. The worker passes this back to
   *  triggerAutomation at drain time. */
  eventType: FollowupTriggerEvent | "appointment.review_request" | "appointment.followup";
  ruleKind: "review_request" | "followup";
  ruleId: string | null;
  delayMinutes: number;
};

export async function enqueueAutomation(args: EnqueueArgs): Promise<{ ok: boolean; id?: string; reason?: string }> {
  try {
    const dueAt = new Date(Date.now() + Math.max(0, args.delayMinutes) * 60_000);
    const [row] = await db
      .insert(pendingAutomations)
      .values({
        tenantId: args.tenantId,
        bookingId: args.bookingId,
        eventType: args.eventType,
        ruleKind: args.ruleKind,
        ruleId: args.ruleId,
        dueAt,
        status: "pending",
      })
      .returning({ id: pendingAutomations.id });
    return { ok: true, id: row.id };
  } catch (e: unknown) {
    // 23505 = unique-violation. The pending_automations_unique_pending
    // index gates against (booking_id, event_type) duplicates while
    // a row is pending/processing. Treat as a benign idempotency hit.
    if ((e as { code?: string })?.code === "23505") {
      return { ok: false, reason: "already_pending" };
    }
    console.error("[automations] enqueue failed (lifecycle unaffected):", e);
    return { ok: false, reason: "insert_failed" };
  }
}
