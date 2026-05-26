/**
 * Phase SMART-3 — adaptive reminder cadence recommendation.
 *
 * PURE function. Returns a recommended reminder schedule for one
 * booking based on its lead time + risk tier. STRICTLY INFORMATIONAL
 * — the existing send-reminders cron is unchanged. The
 * recommendations surface in the admin diagnostics drawer so
 * operators can manually nudge a customer when the engine thinks
 * an extra reminder would help.
 *
 * Why we don't change the cron:
 *   • Deduplication is delicate — the cron uses booking row flags
 *     (reminder_24h_sent_at, reminder_1h_sent_at) for idempotency.
 *     Adding a third "4h" reminder would need a new column +
 *     careful schema migration, with rollout risk.
 *   • The cron's behavior is tested + relied on. SMART-3's value
 *     is SURFACING the recommendation, not enforcing it.
 *
 * Deterministic: same inputs → same outputs. No Math.random.
 */

import type {
  AttendanceRiskAssessment,
  ReminderCadence,
  ReminderRecommendation,
} from "./types";

/** Compute the recommended reminder cadence for a booking. */
export function computeReminderCadence(args: {
  bookingStartAt: Date;
  /** Hours between the booking creation and its start. */
  leadHours: number;
  risk: AttendanceRiskAssessment;
  /** Override `now` for deterministic tests. */
  now?: Date;
}): ReminderCadence {
  const now = args.now ?? new Date();
  const start = args.bookingStartAt;
  const hoursToStart = (start.getTime() - now.getTime()) / 3_600_000;
  const recs: ReminderRecommendation[] = [];

  // ─── Baseline: 24h + 1h ──────────────────────────────────────────
  // These mirror the existing cron's fixed schedule. We list them
  // here so the admin diagnostics view shows the "default cadence"
  // alongside any SMART-3 additions.
  if (hoursToStart >= 24) {
    recs.push({
      sendAt: new Date(start.getTime() - 24 * 3_600_000).toISOString(),
      hoursBeforeBooking: 24,
      reason: "Standard 24-hour reminder.",
      priority: "informational",
    });
  }
  if (hoursToStart >= 1) {
    recs.push({
      sendAt: new Date(start.getTime() - 1 * 3_600_000).toISOString(),
      hoursBeforeBooking: 1,
      reason: "Standard 1-hour reminder.",
      priority: "informational",
    });
  }

  // ─── High-risk addition: 4h reminder ─────────────────────────────
  // For bookings flagged "high" risk, an extra reminder at 4h
  // before start is a well-established attendance-rate booster.
  if (
    args.risk.tier === "high" &&
    hoursToStart >= 4 &&
    // Avoid duplicating the 24h slot when the booking lead is short.
    args.leadHours > 4
  ) {
    recs.push({
      sendAt: new Date(start.getTime() - 4 * 3_600_000).toISOString(),
      hoursBeforeBooking: 4,
      reason: "Customer flagged high risk — extra 4-hour reminder recommended.",
      priority: "recommended",
    });
  }

  // ─── Same-day booking: tighter cadence ──────────────────────────
  // When the booking was placed within 4h of start, the standard
  // 24h reminder is too late and the 1h reminder may collide with
  // the customer's last-minute prep. Recommend a "now" nudge
  // immediately + the 1h reminder.
  if (args.leadHours <= 4 && hoursToStart >= 0.5) {
    recs.push({
      sendAt: now.toISOString(),
      hoursBeforeBooking: hoursToStart,
      reason: "Same-day booking — confirm immediately to reduce ghosting.",
      priority: "recommended",
    });
  }

  // ─── Medium-risk + long lead: gentle 7-day check-in ─────────────
  // For mid-risk customers with a booking > 7 days out, surface a
  // mid-lead reminder. (Long lead times correlate with forgotten
  // bookings.)
  if (
    args.risk.tier === "medium" &&
    args.leadHours > 168 // 7 days
  ) {
    const sevenDayMark = new Date(start.getTime() - 7 * 24 * 3_600_000);
    if (sevenDayMark.getTime() > now.getTime()) {
      recs.push({
        sendAt: sevenDayMark.toISOString(),
        hoursBeforeBooking: 168,
        reason: "Long lead time + moderate risk — 7-day check-in recommended.",
        priority: "informational",
      });
    }
  }

  // Sort chronologically.
  recs.sort((a, b) => a.sendAt.localeCompare(b.sendAt));

  // ─── Headline ────────────────────────────────────────────────────
  let headline = "Standard reminder cadence applies.";
  if (args.risk.tier === "high") {
    headline =
      "High-risk customer — consider an extra reminder and personal follow-up.";
  } else if (args.risk.tier === "medium") {
    headline =
      "Moderate risk — confirm reminder preferences and follow up if needed.";
  } else if (args.leadHours <= 4) {
    headline =
      "Same-day booking — immediate confirmation reduces ghosting risk.";
  }

  return { recommendations: recs, headline };
}
