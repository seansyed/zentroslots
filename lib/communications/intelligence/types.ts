/**
 * Phase SMART-3 — typed contracts for the communication intelligence
 * overlay.
 *
 * This module sits ON TOP of these existing systems and never
 * replaces them:
 *   • lib/analytics/noShowRisk.ts      — pure no-show risk scorer
 *                                        (Phase 71). REUSED via
 *                                        attendancePrediction.ts.
 *   • lib/communications/engine.ts     — send/skip/fail email path.
 *                                        UNTOUCHED.
 *   • scripts/send-reminders.ts        — 24h + 1h reminder cron.
 *                                        UNTOUCHED. The reminder
 *                                        recommendations here are
 *                                        INFORMATIONAL — they tell
 *                                        admins what an ideal
 *                                        cadence would look like;
 *                                        actual sending behavior
 *                                        does not change.
 *   • lib/scheduling/intelligence/     — SMART-1 ranker + customer
 *                                        history. REUSED.
 *
 * Determinism contract:
 *   • Every function is pure or wraps a pure function.
 *   • No Math.random, no Date.now in scorers (callers pass `now`).
 *   • No LLM. Reasoning strings are template-rendered from numeric
 *     thresholds — identical inputs always produce identical
 *     outputs.
 */

/** Risk tier mirrors lib/analytics/noShowRisk.ts so consumers can
 *  treat both signals interchangeably. */
export type AttendanceRiskTier = "low" | "medium" | "high";

/** Per-booking attendance risk assessment. Wraps the existing
 *  scoreNoShowRisk() output with booking-context fields that the
 *  admin UI surfaces. */
export type AttendanceRiskAssessment = {
  /** 0..100, higher = more likely no-show. */
  score: number;
  tier: AttendanceRiskTier;
  /** Human-readable contributing factors, derived deterministically
   *  from the underlying signals. Up to 5 lines. */
  reasons: string[];
  /** Booking lead time (hours between when the booking was created
   *  and its start). Surfaced separately for the admin drawer. */
  leadHours: number;
  /** Echo of the input signals so the admin diagnostics view can
   *  show the raw numbers. */
  signals: {
    priorCancellations: number;
    priorNoShows: number;
    rescheduleCount: number;
    reminderSuppressed: boolean;
    missedConfirmation: boolean;
  };
  /** When the assessment was generated (ISO). */
  generatedAt: string;
};

/** Customer-level engagement aggregate across their entire history
 *  with this tenant. Used by the admin "repeat offenders" list +
 *  the per-booking risk computation. Strictly tenant-scoped at the
 *  query layer. */
export type CustomerEngagementProfile = {
  /** Lowered email is the key. Returned in the result so the
   *  admin UI can sort/filter. */
  email: string;
  totalBookings: number;
  completedBookings: number;
  noShowBookings: number;
  cancelledBookings: number;
  /** Times we observed status moving to "cancelled" while in the
   *  reschedule UI — approximated via repeated rapid updatedAt
   *  bumps. Imperfect but consistent. */
  rescheduleCount: number;
  /** [0..1] — derived metrics for fast sorting. */
  noShowRate: number;
  cancellationRate: number;
  completionRate: number;
  /** Most recent booking start (for staleness sorting). */
  lastBookingAt: string | null;
};

/** A single recommended reminder, informational only. The send-
 *  reminders cron does NOT consult this — it lives separately. The
 *  admin "communication intelligence" page surfaces these as hints
 *  for an operator who wants to manually nudge a customer. */
export type ReminderRecommendation = {
  /** Suggested send time (ISO). */
  sendAt: string;
  /** How many hours before the booking this reminder fires. */
  hoursBeforeBooking: number;
  /** Why this reminder is recommended. Template-rendered. */
  reason: string;
  /** Priority — drives the order of any list rendering. */
  priority: "informational" | "recommended" | "high_priority";
};

/** Recommended reminder cadence for one booking. Returned by
 *  communicationTiming.computeReminderCadence(). */
export type ReminderCadence = {
  /** Ordered chronologically. */
  recommendations: ReminderRecommendation[];
  /** Single-sentence summary, e.g. "High-risk customer — consider
   *  an extra 4h reminder + personal follow-up." */
  headline: string;
};

/** Deterministic admin hints. Pure-template — never LLM-generated. */
export type MessageRecommendation = {
  /** Stable code for telemetry + i18n. */
  code:
    | "high_risk_personal_outreach"
    | "repeat_no_show_call"
    | "same_day_short_reminder"
    | "long_lead_confirmation"
    | "post_cancellation_recovery"
    | "vip_white_glove";
  /** Short message shown in the admin UI. Template-rendered. */
  message: string;
  /** Reasoning behind the recommendation (deterministic). */
  evidence: string;
};

/** Communication-side metrics for the admin observability endpoint. */
export type CommunicationIntelligenceMetrics = {
  tenantId: string;
  generatedAt: string;
  windowDays: number;
  /** Aggregate reminder send + suppression counts. */
  reminders: {
    sent: number;
    suppressed: number;
    failed: number;
    /** [0..100] — what fraction of bookings that were due a
     *  reminder actually got one delivered. */
    effectivenessPct: number;
  };
  attendance: {
    completedBookings: number;
    noShowBookings: number;
    /** [0..100]. */
    attendanceRatePct: number;
  };
  /** Customers ranked by no-show rate (descending). Top 10 only,
   *  to keep the payload small. */
  highRiskCustomers: CustomerEngagementProfile[];
  /** Upcoming bookings (next 7 days) flagged high-risk. Top 10. */
  upcomingHighRiskBookings: {
    bookingId: string;
    clientName: string;
    clientEmail: string;
    startAt: string;
    riskTier: AttendanceRiskTier;
    riskScore: number;
    reasons: string[];
  }[];
};

/** Booking density observation for a (staff, hour-of-day, day-of-week)
 *  cell over a rolling 30-day window. Used to render the "Popular
 *  time" UI hint without changing slot-correctness. */
export type BookingDensityHint = {
  staffUserId: string;
  /** "popular" — count is significantly above the staff's mean.
   *  "high_demand" — count is at or above the workspace mean for
   *  this hour AND the staff's same-hour rate is rising. */
  signal: "popular" | "high_demand" | null;
  /** Backing count of past bookings in this cell (last 30 days). */
  observedCount: number;
};
