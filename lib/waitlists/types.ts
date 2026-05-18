/**
 * Closed unions for the waitlist subsystem.
 */

export type WaitlistStatus =
  | "waiting"
  | "notified"
  | "claimed"
  | "expired"
  | "cancelled";

export type WaitlistTimeRange = "morning" | "afternoon" | "evening" | "any";

export const WAITLIST_TIME_RANGES: readonly WaitlistTimeRange[] = [
  "morning",
  "afternoon",
  "evening",
  "any",
] as const;

export type WaitlistNotificationType =
  | "slot_available"
  | "reservation_expiring"
  | "reservation_claimed";

export type WaitlistNotificationStatus =
  | "sent"
  | "expired"
  | "claimed"
  | "failed";

/** Default reservation hold (minutes). 15 per spec. */
export const DEFAULT_RESERVATION_MINUTES = 15;
