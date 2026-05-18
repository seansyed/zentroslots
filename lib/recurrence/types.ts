/**
 * Shared types for the recurrence subsystem.
 *
 * Minimal RFC 5545 RRULE subset — we deliberately don't implement the
 * full standard. Adding a new field requires extending the parser AND
 * the expander explicitly, so the supported surface is small and
 * auditable. No leaky shorthand.
 */

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY";

export const FREQUENCIES: readonly Frequency[] = ["DAILY", "WEEKLY", "MONTHLY"] as const;

/** RFC 5545 two-letter weekday codes. Order matters for SU-anchored
 *  weeks but our engine treats weeks as Monday-first locally. */
export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA";

export const WEEKDAYS: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** Map RFC 5545 weekday to JS Date.getDay() (0=Sun..6=Sat). */
export const WEEKDAY_TO_INDEX: Record<Weekday, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

export type RecurrenceRule = {
  freq: Frequency;
  /** Every N days/weeks/months. Default 1. */
  interval: number;
  /** For WEEKLY: which weekdays to fire on (empty = anchor's weekday only). */
  byday?: Weekday[];
  /** UTC date (inclusive) to stop at. Mutually exclusive with count. */
  until?: Date;
  /** Hard cap on number of occurrences. Mutually exclusive with until. */
  count?: number;
};

export type SeriesStatus = "active" | "paused" | "cancelled" | "completed";

export type OccurrenceStatus =
  | "scheduled"
  | "completed"
  | "cancelled"
  | "skipped"
  | "failed";

/** Per-occurrence override deviation. Closed shape; merge rules in
 *  exceptions.ts. */
export type OccurrenceOverride = {
  /** ISO start_at to use instead of the rule-computed start. */
  startAt?: string;
  /** Different staff for THIS occurrence only. */
  staffUserId?: string;
  /** Skip flag — equivalent to status='skipped' but kept on the override
   *  so admins can flip it back without losing the audit trail. */
  skip?: boolean;
  note?: string;
};
