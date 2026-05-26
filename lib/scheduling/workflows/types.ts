/**
 * Phase SMART-2 — typed contracts for scheduling workflow
 * orchestration.
 *
 * This module sits ABOVE Phase SMART-1 (slot intelligence) and
 * COMPOSES with these existing systems — it does not replace them:
 *   • lib/availability.ts            — source of truth for which
 *                                      slots exist (UNTOUCHED)
 *   • lib/scheduling/intelligence/   — scoring + labels (REUSED via
 *                                      recommendSlots())
 *   • lib/waitlists/                 — slot recovery for queued
 *                                      customers (UNTOUCHED — the
 *                                      cancel route already calls
 *                                      releaseSlot())
 *   • lib/automations/               — pending queue + delayed
 *                                      follow-up dispatch (UNTOUCHED;
 *                                      cancel route now enqueues a
 *                                      booking.cancelled event so
 *                                      existing automation rules can
 *                                      react)
 *   • lib/booking-rules/             — caps + blackouts (UNTOUCHED)
 *
 * Determinism contract:
 *   • Every workflow recommendation is a deterministic function of
 *     (booking row, window, scoring rules, customer history).
 *   • No Math.random, no Date.now in scorers — callers pass `now`.
 *   • No generative AI — `reasoning` strings are template-rendered
 *     from the SMART-1 factor breakdown.
 */

import type { ScoredSlot } from "@/lib/scheduling/intelligence/types";

/** One workflow recommendation surfaced in the UI or in an email.
 *  Wraps a SMART-1 ScoredSlot with a workflow-level reason and
 *  comparison metadata against the customer's currently-booked
 *  time. */
export type WorkflowRecommendation = {
  /** Slot start ISO UTC. Matches what /api/slots returns. */
  time: string;
  /** SMART-1 composite score [0..100]. */
  score: number;
  /** SMART-1 UI labels (e.g. "recommended", "best_availability"). */
  labels: string[];
  /** Human-readable reasoning lines, derived deterministically from
   *  SMART-1's factor breakdown. NEVER LLM-generated. Example:
   *  ["Morning slot — most popular for staff", "No focus blocks",
   *   "Customer historically books 10am"]. */
  reasoning: string[];
  /** Difference from the customer's currently-booked time in minutes.
   *  Negative = earlier; positive = later. Null when not comparing
   *  to an existing booking (e.g. cancellation recovery on a now-
   *  invalid booking). */
  deltaMinutes: number | null;
  /** Comparison tag — workflows-level UI hint:
   *    "earlier"        — slot is before the currently-booked time
   *    "same_day"       — slot is on the same day but later/earlier
   *                       than current
   *    "different_day"  — slot is on a different day
   *    "first_available" — earliest slot in the result set (only one
   *                       per recommendation list) */
  comparison: WorkflowComparison;
};

export type WorkflowComparison =
  | "earlier"
  | "same_day"
  | "different_day"
  | "first_available";

/** Top-of-the-list summary for a workflow recommendation set.
 *  Surfaced as a single sentence at the top of the reschedule UI
 *  or in the cancellation email body. Deterministic + template-
 *  rendered. */
export type WorkflowHeadline = {
  /** Short headline, e.g. "Best alternative: Mon 10:00 AM". */
  text: string;
  /** ISO time of the slot the headline refers to (matches one of
   *  the recommendations). Null when no clear best exists. */
  highlightSlot: string | null;
};

/** Full result returned by every workflow orchestrator
 *  (reschedule, cancellation recovery, slot recovery). */
export type WorkflowResult = {
  /** Top recommendations, sorted by score DESC (then time ASC).
   *  Always ≤ MAX_RECOMMENDATIONS items. */
  recommendations: WorkflowRecommendation[];
  /** Optional summary headline — null when no clear best slot. */
  headline: WorkflowHeadline | null;
  /** Original scored set (input order, ALL slots) — preserved so
   *  the UI can render the full slot grid alongside the highlighted
   *  recommendations. */
  allScored: ScoredSlot[];
  /** Generated-at timestamp (ISO). Useful for cache invalidation
   *  + the admin dashboard "last computed" column. */
  generatedAt: string;
};

/** Hard cap on items returned per workflow call. We never surface
 *  more than 3 alternatives — choice paralysis is real, and the
 *  full slot list is still available in the UI below the headline. */
export const MAX_RECOMMENDATIONS = 3;

/** Time-of-day buckets used in determinism-safe headline rendering. */
export type TimeOfDay = "early-morning" | "morning" | "midday" | "afternoon" | "evening";
