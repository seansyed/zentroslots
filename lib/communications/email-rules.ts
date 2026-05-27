/**
 * Pure rule predicates for customer-facing email gating.
 *
 * No DB, no env reads, no side effects — call these with a normalized
 * `ClientCommPrefs` and a kind, get a `{ allowed, reason }` decision.
 * The DB-aware wrapper lives in lib/communications/preferences.ts.
 *
 * Scope: scheduling/customer-communication emails ONLY. This module
 * MUST NEVER be applied to:
 *   - magic-link auth emails
 *   - billing/Stripe receipts
 *   - password resets (none today; defense in depth)
 *   - security/compliance notices
 *
 * The categorization lives here as a hard whitelist (`SchedulingEmailKind`)
 * — if a kind isn't in this union, the gate function will simply not
 * accept it, which is the safety we want.
 */

import type { ClientCommPrefs } from "@/lib/client-prefs";

/**
 * The complete set of customer-facing scheduling emails. Adding a new
 * kind requires a deliberate code change here — preventing accidental
 * gating of auth or billing emails.
 */
export type SchedulingEmailKind =
  | "appointment_confirmation"
  | "appointment_cancelled"
  | "appointment_rescheduled"
  | "appointment_reminder_24h"
  | "appointment_reminder_1h"
  | "appointment_completed"
  | "appointment_no_show"
  | "appointment_review_request"
  | "appointment_followup"
  | "appointment_waitlist_slot_available";

export type GateDecision =
  | { allowed: true; reason?: never }
  | {
      allowed: false;
      reason:
        | "email_disabled"
        | "reminder24h_disabled"
        | "reminder1h_disabled"
        // Phase 2A — per-event reasons
        | "confirmations_disabled"
        | "cancellations_disabled"
        | "waitlist_disabled"
        // Migration 0070 — demo tenant suppression. When the booking's
        // tenant is flagged is_demo=true, all scheduling emails are
        // silently dropped so the docs-demo workspace never sends real
        // mail. Logged via lib/demo-safe.ts logDemoSuppression.
        | "demo_tenant";
    };

/**
 * Decide whether a transactional scheduling email may be delivered to a
 * customer given their preferences. Returns a structured decision so
 * the caller can log the suppression reason.
 *
 * Semantics:
 *   - `emailEnabled = false` blocks ALL scheduling email (master switch).
 *   - Reminder kinds additionally require the matching per-window toggle.
 *   - Phase 2A: confirmation, cancellation, and waitlist-slot-available
 *     each gain their own per-event toggle. Defaults to `true` for all
 *     pre-existing customers (see normalizePrefs) so behavior is
 *     byte-identical until a customer opts out.
 *   - Reschedule notices remain governed by the master switch only —
 *     a reschedule is a substantive state change the customer needs to
 *     know about; the master switch is the appropriate granularity.
 */
export function decideSchedulingEmail(
  prefs: ClientCommPrefs,
  kind: SchedulingEmailKind
): GateDecision {
  if (!prefs.emailEnabled) return { allowed: false, reason: "email_disabled" };

  switch (kind) {
    case "appointment_reminder_24h":
      if (!prefs.reminder24hEnabled) return { allowed: false, reason: "reminder24h_disabled" };
      break;
    case "appointment_reminder_1h":
      if (!prefs.reminder1hEnabled) return { allowed: false, reason: "reminder1h_disabled" };
      break;
    case "appointment_confirmation":
      if (!prefs.confirmationsEnabled) return { allowed: false, reason: "confirmations_disabled" };
      break;
    case "appointment_cancelled":
      if (!prefs.cancellationsEnabled) return { allowed: false, reason: "cancellations_disabled" };
      break;
    case "appointment_waitlist_slot_available":
      if (!prefs.waitlistEnabled) return { allowed: false, reason: "waitlist_disabled" };
      break;
    // Reschedule, completed, no_show, review_request, followup remain
    // governed by the master `emailEnabled` switch only — they're
    // either substantive state changes or content the host explicitly
    // opted into per service (followups + review requests are
    // tenant-side configured).
    default:
      break;
  }
  return { allowed: true };
}

/**
 * Convenience for the existing reminder cron call sites that don't want
 * to construct a kind string. Mirrors the previous lib/client-prefs.ts
 * helper for source compatibility.
 */
export function isReminderAllowed(prefs: ClientCommPrefs, windowHours: 24 | 1): boolean {
  const kind: SchedulingEmailKind =
    windowHours === 24 ? "appointment_reminder_24h" : "appointment_reminder_1h";
  return decideSchedulingEmail(prefs, kind).allowed;
}
