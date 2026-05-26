/**
 * Phase SMART-2 — cancellation recovery orchestrator.
 *
 * When a staff member or the customer cancels a booking, we have an
 * opportunity to soften the impact by suggesting the next best
 * alternative IMMEDIATELY — both in the cancellation email body and
 * in any future "Cancelled — book again?" CTA.
 *
 * This is functionally identical to reschedule recommendations
 * (same SMART-1 ranking, same MAX_RECOMMENDATIONS cap) but with a
 * different reference anchor:
 *   • Reschedule:    anchor = the customer's currently-booked time
 *                    (so we can tag "earlier than your current slot")
 *   • Cancellation:  anchor = the cancelled booking's ORIGINAL start
 *                    (so we tag "same day as your cancelled slot")
 *
 * The two orchestrators share the same workflowRules helpers; only
 * the entry signature + reference anchor differ.
 *
 * The orchestrator NEVER books anything. It surfaces options. The
 * existing /api/bookings POST endpoint is the only path that
 * confirms a slot — preserving the existing transactional EXCLUDE
 * constraint + booking_rules validation.
 */

import { buildRescheduleRecommendations } from "./rescheduleRecommendations";
import type { WorkflowResult } from "./types";

export type CancellationRecoveryInput = {
  /** The cancelled booking's ORIGINAL start time. Used as the
   *  comparison anchor — recommendations are tagged relative to
   *  what the customer just lost. */
  cancelledBookingStart: Date;
  tenantId: string;
  serviceId: string;
  staffUserId: string;
  timezone: string;
  customerEmail?: string;
  customerTimezone?: string;
};

export async function buildCancellationRecovery(
  input: CancellationRecoveryInput,
): Promise<WorkflowResult> {
  // The reschedule orchestrator already does exactly what we need
  // — search forward, rank with SMART-1, return top-3 with workflow
  // tagging. We just pass the cancelled-booking start as the
  // reference time (so the UI gets "Same day as your original
  // appointment" tagging when applicable).
  return buildRescheduleRecommendations({
    currentBookingStart: input.cancelledBookingStart,
    tenantId: input.tenantId,
    serviceId: input.serviceId,
    staffUserId: input.staffUserId,
    timezone: input.timezone,
    customerEmail: input.customerEmail,
    customerTimezone: input.customerTimezone,
  });
}
