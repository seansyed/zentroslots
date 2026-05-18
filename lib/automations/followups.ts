/**
 * Follow-up automation orchestrator.
 *
 * Called from the booking-status route when a booking transitions to
 * a terminal status. Looks up all enabled followup_automation_rules
 * matching (tenant, service?, trigger_event) and enqueues a pending
 * automation for each. Conditional checks (first-time customer,
 * payment) are evaluated at queue-drain time, not enqueue.
 *
 * Multiple rules can fire for the same booking — e.g. a tenant
 * default "Thank you" + a service-specific "Post-care instructions".
 * They're separate pending_automations rows and use distinct
 * eventType strings; communication_logs idempotency keys are unique
 * per (tenant, booking, event, channel) so no double-send.
 *
 * NEVER throws.
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { followupAutomationRules } from "@/db/schema";

import { enqueueAutomation } from "./enqueue";
import type { FollowupTriggerEvent } from "./types";

export type FollowupInput = {
  tenantId: string;
  serviceId: string;
  bookingId: string;
  triggerEvent: FollowupTriggerEvent;
};

export type FollowupResult = {
  enqueued: number;
  /** Per-rule outcomes for the audit log. */
  outcomes: Array<{ ruleId: string; ok: boolean; reason?: string }>;
};

export async function onBookingTerminalFollowups(
  input: FollowupInput
): Promise<FollowupResult> {
  try {
    const rules = await db
      .select()
      .from(followupAutomationRules)
      .where(
        and(
          eq(followupAutomationRules.tenantId, input.tenantId),
          eq(followupAutomationRules.triggerEvent, input.triggerEvent),
          eq(followupAutomationRules.enabled, true),
          sql`(${followupAutomationRules.serviceId} = ${input.serviceId} OR ${followupAutomationRules.serviceId} IS NULL)`
        )
      );

    if (rules.length === 0) return { enqueued: 0, outcomes: [] };

    // De-duplicate: if both a service-specific rule and a tenant default
    // match for the same trigger_event, the service-specific wins.
    // Otherwise tenants are paying for the same email twice.
    const serviceSpecific = rules.find((r) => r.serviceId === input.serviceId);
    const winners = serviceSpecific ? [serviceSpecific] : rules.filter((r) => r.serviceId === null);

    const outcomes: FollowupResult["outcomes"] = [];
    let enqueued = 0;
    for (const rule of winners) {
      const enqueue = await enqueueAutomation({
        tenantId: input.tenantId,
        bookingId: input.bookingId,
        eventType: "appointment.followup",
        ruleKind: "followup",
        ruleId: rule.id,
        delayMinutes: rule.delayMinutes,
      });
      if (enqueue.ok) {
        enqueued++;
        outcomes.push({ ruleId: rule.id, ok: true });
      } else {
        outcomes.push({ ruleId: rule.id, ok: false, reason: enqueue.reason });
      }
    }
    return { enqueued, outcomes };
  } catch (e) {
    console.error("[automations] followups orchestrator failed:", e);
    return { enqueued: 0, outcomes: [] };
  }
}
