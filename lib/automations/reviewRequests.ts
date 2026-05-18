/**
 * Review-request orchestrator.
 *
 * Called from the booking-status route when a booking flips to
 * 'completed'. Resolves the most specific review_request_rules row
 * (service > tenant default), checks suppression flags, and enqueues
 * a pending automation to fire after `delay_minutes`.
 *
 * No-show / cancelled status flips MUST NOT call this function (the
 * caller already short-circuits) — the suppress_if_* flags are a
 * second layer of defense.
 *
 * NEVER throws. Rule #13: lifecycle ops are not allowed to fail
 * because an automation orchestrator failed.
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/db/client";
import { reviewRequestRules } from "@/db/schema";

import { enqueueAutomation } from "./enqueue";

export type ReviewRequestInput = {
  tenantId: string;
  serviceId: string;
  bookingId: string;
  /** Final status after the flip. Most calls will be 'completed'; the
   *  function still checks suppress_if_* flags so the caller can pass
   *  any terminal status and rely on the rule's intent. */
  status: "completed" | "cancelled" | "no_show";
};

export type ReviewRequestResult =
  | { ok: true; pendingId: string; ruleId: string; delayMinutes: number }
  | { ok: false; reason: string };

export async function onBookingTerminalReviewRequest(
  input: ReviewRequestInput
): Promise<ReviewRequestResult> {
  try {
    // Resolve the matching rule. Service-specific wins over tenant default.
    const candidates = await db
      .select()
      .from(reviewRequestRules)
      .where(
        and(
          eq(reviewRequestRules.tenantId, input.tenantId),
          // service-specific OR tenant default
          // (neither references location for this feature)
          // — using two-arg OR via SQL would also work; this is clearer.
        )
      );
    if (candidates.length === 0) return { ok: false, reason: "no_rule" };

    const winner =
      candidates.find((r) => r.serviceId === input.serviceId) ??
      candidates.find((r) => r.serviceId === null) ??
      null;
    if (!winner) return { ok: false, reason: "no_rule" };

    if (!winner.enabled) return { ok: false, reason: "rule_disabled" };

    if (input.status === "cancelled" && winner.suppressIfCancelled) {
      return { ok: false, reason: "suppress_cancelled" };
    }
    if (input.status === "no_show" && winner.suppressIfNoShow) {
      return { ok: false, reason: "suppress_no_show" };
    }

    // The review URL is REQUIRED to render a useful CTA. If admins
    // turn the rule on without setting a URL, skip rather than ship
    // an empty button. The admin UI also flags this state.
    if (!winner.reviewUrl) return { ok: false, reason: "no_review_url" };

    const enqueue = await enqueueAutomation({
      tenantId: input.tenantId,
      bookingId: input.bookingId,
      eventType: "appointment.review_request",
      ruleKind: "review_request",
      ruleId: winner.id,
      delayMinutes: winner.delayMinutes,
    });
    if (!enqueue.ok) {
      return { ok: false, reason: enqueue.reason ?? "enqueue_failed" };
    }
    return {
      ok: true,
      pendingId: enqueue.id!,
      ruleId: winner.id,
      delayMinutes: winner.delayMinutes,
    };
  } catch (e) {
    console.error("[automations] review-request orchestrator failed:", e);
    return { ok: false, reason: "orchestrator_error" };
  }
}

// isNull is imported above for future location-scope queries; reserved.
void isNull;
