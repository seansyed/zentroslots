/**
 * Phase SMART-3 — deterministic admin hint generator.
 *
 * Given a per-booking risk assessment + customer engagement profile,
 * emits a small set of operator-facing recommendations. Every line
 * is template-rendered from numeric thresholds — NEVER LLM-generated.
 * Strictly pure: same inputs → same outputs across calls.
 *
 * Hints are advisory. They surface in the admin booking drawer +
 * the communication intelligence dashboard. The reminders cron +
 * email engine remain the sole path that actually sends mail.
 */

import type {
  AttendanceRiskAssessment,
  CustomerEngagementProfile,
  MessageRecommendation,
} from "./types";

/** Compose deterministic hints. Cap at 3 to keep the UI readable. */
export function recommendMessages(args: {
  risk: AttendanceRiskAssessment;
  /** Customer engagement profile — may be null when the customer
   *  has no history with this tenant. */
  engagement: CustomerEngagementProfile | null;
  /** Lead hours for the current booking. Drives the
   *  same_day_short_reminder / long_lead_confirmation branches. */
  leadHours: number;
  /** Set true when this booking is being created in the context
   *  of a recent cancellation by the same customer. */
  isPostCancellation?: boolean;
}): MessageRecommendation[] {
  const out: MessageRecommendation[] = [];

  // 1. High-risk personal outreach. Strongest signal first.
  if (args.risk.tier === "high") {
    out.push({
      code: "high_risk_personal_outreach",
      message:
        "Consider a personal email or quick call to confirm attendance.",
      evidence: `Attendance risk: ${args.risk.score}/100 (high).`,
    });
  }

  // 2. Repeat no-show — recommend a phone call when the customer
  //    has a track record. Threshold: ≥2 prior no-shows.
  if (args.engagement && args.engagement.noShowBookings >= 2) {
    out.push({
      code: "repeat_no_show_call",
      message:
        "Customer has missed multiple appointments — recommend phone confirmation.",
      evidence: `${args.engagement.noShowBookings} no-shows on record.`,
    });
  }

  // 3. Same-day booking — confirm fast.
  if (args.leadHours <= 4 && out.length < 3) {
    out.push({
      code: "same_day_short_reminder",
      message:
        "Same-day booking — send confirmation immediately + an SMS-style nudge.",
      evidence: `Lead time: ${Math.round(args.leadHours * 10) / 10} hours.`,
    });
  }

  // 4. Long lead time — gentle mid-window check-in.
  if (args.leadHours >= 168 && out.length < 3) {
    out.push({
      code: "long_lead_confirmation",
      message:
        "Long lead time — consider a 1-week check-in to keep the booking top-of-mind.",
      evidence: `Lead time: ${Math.round(args.leadHours / 24)} days.`,
    });
  }

  // 5. Post-cancellation recovery — soften the next outreach.
  if (args.isPostCancellation && out.length < 3) {
    out.push({
      code: "post_cancellation_recovery",
      message:
        "Customer just cancelled — recovery outreach should be warm and offer flexible alternatives.",
      evidence:
        "Recent cancellation detected in workflow recovery context.",
    });
  }

  // 6. VIP white-glove — customers with high completion + multi-
  //    booking history deserve personalized handling regardless of
  //    risk tier.
  const isVip =
    args.engagement &&
    args.engagement.totalBookings >= 5 &&
    args.engagement.completionRate >= 0.9;
  if (isVip && out.length < 3) {
    out.push({
      code: "vip_white_glove",
      message:
        "Repeat customer with high attendance — white-glove handling recommended.",
      evidence: `${args.engagement!.completedBookings}/${args.engagement!.totalBookings} completed (${Math.round(args.engagement!.completionRate * 100)}%).`,
    });
  }

  return out.slice(0, 3);
}
