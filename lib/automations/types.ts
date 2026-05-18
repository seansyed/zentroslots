/**
 * Shared types for the post-booking automation layer.
 */

export type ReviewPlatform = "google" | "yelp" | "facebook" | "custom";
export const REVIEW_PLATFORMS: readonly ReviewPlatform[] = [
  "google",
  "yelp",
  "facebook",
  "custom",
] as const;

/** Trigger events recognized by follow-up rules. */
export type FollowupTriggerEvent =
  | "appointment.completed"
  | "appointment.cancelled"
  | "appointment.no_show"
  | "appointment.followup_due";

export const FOLLOWUP_TRIGGER_EVENTS: readonly FollowupTriggerEvent[] = [
  "appointment.completed",
  "appointment.cancelled",
  "appointment.no_show",
  "appointment.followup_due",
] as const;

/** Closed reason codes the queue worker writes when it skips a row. */
export type PendingSkipReason =
  | "rule_disabled"
  | "rule_missing"
  | "suppress_cancelled"
  | "suppress_no_show"
  | "not_first_time_customer"
  | "not_completed"
  | "payment_required"
  | "feature_disabled"
  | "booking_missing"
  | "engine_failed"
  | "engine_skipped"
  | "unknown";
