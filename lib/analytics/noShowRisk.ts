/**
 * Per-booking no-show risk scoring — deterministic, explainable.
 *
 * Inputs are RAW SIGNALS (counts, booleans, durations). The scorer
 * adds points per signal; a final 0..100 score → {low, medium, high}
 * tier with a list of reasons cited. No ML, no AI.
 *
 * Pure — no DB. The DB layer assembles the BookingSignals struct
 * from per-booking aggregates and feeds it in. Aggregation writes
 * COUNTS only (high/medium/low) into snapshot extras; per-booking
 * scoring lives at the read-side (future endpoint) where the rich
 * shape is useful.
 *
 * Closed signal set — adding a new signal requires updating the
 * scorer + the tests.
 */

export type RiskTier = "low" | "medium" | "high";

export type BookingSignals = {
  /** Lead time between booking createdAt and startAt (hours). */
  leadHours: number;
  /** Count of prior cancellations by this customer (tenant-scoped). */
  priorCancellations: number;
  /** Count of prior no-shows by this customer. */
  priorNoShows: number;
  /** Count of times this booking has been rescheduled. */
  rescheduleCount: number;
  /** Reminder emails suppressed (customer opted out of reminders). */
  reminderSuppressed: boolean;
  /** Customer never opened the confirmation email (proxy: confirmation
   *  email status is sent but no further engagement signals received). */
  missedConfirmation: boolean;
};

export type RiskAssessment = {
  tier: RiskTier;
  score: number; // 0..100
  reasons: string[];
};

// ─── Thresholds — change here only ───────────────────────────────────

const SHORT_LEAD_HOURS = 4;          // <= 4h before start
const VERY_SHORT_LEAD_HOURS = 2;
const SHORT_LEAD_POINTS = 15;
const VERY_SHORT_LEAD_POINTS = 25;

const PRIOR_CANCEL_POINTS_EACH = 10; // capped at 30
const PRIOR_CANCEL_MAX_POINTS = 30;
const PRIOR_NOSHOW_POINTS_EACH = 20; // capped at 40
const PRIOR_NOSHOW_MAX_POINTS = 40;

const RESCHEDULE_POINTS_EACH = 8;
const RESCHEDULE_MAX_POINTS = 24;

const REMINDER_SUPPRESSED_POINTS = 10;
const MISSED_CONFIRMATION_POINTS = 12;

const MEDIUM_THRESHOLD = 30;
const HIGH_THRESHOLD = 60;

export function scoreNoShowRisk(signals: BookingSignals): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];

  // Lead time — closer to start = higher risk (no time to remind/forget).
  if (signals.leadHours <= VERY_SHORT_LEAD_HOURS) {
    score += VERY_SHORT_LEAD_POINTS;
    reasons.push(`Booking placed within ${VERY_SHORT_LEAD_HOURS}h of start.`);
  } else if (signals.leadHours <= SHORT_LEAD_HOURS) {
    score += SHORT_LEAD_POINTS;
    reasons.push(`Booking placed within ${SHORT_LEAD_HOURS}h of start.`);
  }

  // Prior cancellations (capped).
  if (signals.priorCancellations > 0) {
    const pts = Math.min(PRIOR_CANCEL_MAX_POINTS, signals.priorCancellations * PRIOR_CANCEL_POINTS_EACH);
    score += pts;
    reasons.push(
      `${signals.priorCancellations} prior cancellation${signals.priorCancellations === 1 ? "" : "s"}.`
    );
  }

  // Prior no-shows (capped) — the strongest signal.
  if (signals.priorNoShows > 0) {
    const pts = Math.min(PRIOR_NOSHOW_MAX_POINTS, signals.priorNoShows * PRIOR_NOSHOW_POINTS_EACH);
    score += pts;
    reasons.push(
      `${signals.priorNoShows} prior no-show${signals.priorNoShows === 1 ? "" : "s"}.`
    );
  }

  // Reschedule count — repeated reschedules predict disengagement.
  if (signals.rescheduleCount > 0) {
    const pts = Math.min(RESCHEDULE_MAX_POINTS, signals.rescheduleCount * RESCHEDULE_POINTS_EACH);
    score += pts;
    reasons.push(
      `Rescheduled ${signals.rescheduleCount} time${signals.rescheduleCount === 1 ? "" : "s"}.`
    );
  }

  // Reminder suppression — customer opted out, won't get nudged.
  if (signals.reminderSuppressed) {
    score += REMINDER_SUPPRESSED_POINTS;
    reasons.push("Reminder emails are suppressed.");
  }

  // Missed confirmation — proxy for engagement.
  if (signals.missedConfirmation) {
    score += MISSED_CONFIRMATION_POINTS;
    reasons.push("Did not engage with confirmation email.");
  }

  // Clamp to 0..100.
  score = Math.max(0, Math.min(100, score));

  let tier: RiskTier;
  if (score >= HIGH_THRESHOLD) tier = "high";
  else if (score >= MEDIUM_THRESHOLD) tier = "medium";
  else tier = "low";

  return { tier, score, reasons };
}

/** Tier breakpoints exposed for tests. */
export const _thresholds = {
  SHORT_LEAD_HOURS,
  VERY_SHORT_LEAD_HOURS,
  MEDIUM_THRESHOLD,
  HIGH_THRESHOLD,
} as const;
