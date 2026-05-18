/**
 * Send the "slot available" email to the customer holding a waitlist
 * reservation. Routes through the existing triggerAutomation engine
 * so the same template-resolution + customer-pref gate apply.
 *
 * The orchestrator (releaseSlot) returns the claim URL + expiresAt;
 * this function injects them as contextExtras so the template's
 * {{claim_url}} and {{claim_expires_at}} render correctly.
 *
 * NEVER throws.
 */
import { formatInTimeZone } from "date-fns-tz";

import { triggerAutomation } from "@/lib/communications/engine";

export type NotifySlotAvailableInput = {
  tenantId: string;
  /** A booking id is REQUIRED by the engine's idempotency layer.
   *  releaseSlot is triggered by an originating booking
   *  (cancel/reschedule); pass that id here. The communication_logs
   *  partial unique index keys on (tenant, booking, event, channel)
   *  so a single cancel can't fire two slot_available emails to the
   *  same waitlist customer accidentally. */
  bookingId: string;
  customerEmail: string;
  claimUrl: string;
  expiresAt: Date;
  staffTimezone: string;
};

export async function notifySlotAvailable(input: NotifySlotAvailableInput): Promise<void> {
  try {
    await triggerAutomation({
      tenantId: input.tenantId,
      bookingId: input.bookingId,
      eventType: "appointment.waitlist_slot_available",
      contextExtras: {
        claim_url: input.claimUrl,
        claim_expires_at: formatInTimeZone(
          input.expiresAt,
          input.staffTimezone || "UTC",
          "EEE MMM d, h:mm a zzz"
        ),
      },
    });
  } catch (e) {
    // The engine itself is wrapped in try/catch and logs to
    // communication_logs. This is the absolute last-resort guard.
    console.error("[waitlists] notifySlotAvailable failed:", e);
  }
}
