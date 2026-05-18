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
  | "appointment_reminder_1h";

export type GateDecision =
  | { allowed: true; reason?: never }
  | { allowed: false; reason: "email_disabled" | "reminder24h_disabled" | "reminder1h_disabled" };

/**
 * Decide whether a transactional scheduling email may be delivered to a
 * customer given their preferences. Returns a structured decision so
 * the caller can log the suppression reason.
 *
 * Semantics:
 *   - `emailEnabled = false` blocks ALL scheduling email (master switch).
 *   - Reminder kinds additionally require the matching per-window toggle.
 *   - Confirmation/cancellation/reschedule check only the master switch
 *     (operationally important; we still tell the customer their
 *      appointment changed, but only if they want any email at all).
 */
export function decideSchedulingEmail(
  prefs: ClientCommPrefs,
  kind: SchedulingEmailKind
): GateDecision {
  if (!prefs.emailEnabled) return { allowed: false, reason: "email_disabled" };

  if (kind === "appointment_reminder_24h") {
    if (!prefs.reminder24hEnabled) return { allowed: false, reason: "reminder24h_disabled" };
  } else if (kind === "appointment_reminder_1h") {
    if (!prefs.reminder1hEnabled) return { allowed: false, reason: "reminder1h_disabled" };
  }
  // Confirmation / cancellation / reschedule have no per-event toggle
  // beyond the master switch — they're transactional courtesies.
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
