/**
 * Phase SMART-1 — slot ranking + label assignment.
 *
 * Takes the raw slot list from getAvailableSlots() + the shared
 * SlotContext (rules, customer profile, staff workload, etc.) and
 * produces ScoredSlot[] — same slots, in same order, but each
 * annotated with score + UI labels.
 *
 * Ordering contract:
 *   • OUTPUT ARRAY ORDER === INPUT ARRAY ORDER. We do NOT re-sort
 *     by score. The booking page renders the day's slots
 *     chronologically; reordering by score would confuse customers
 *     ("why is 2pm shown before 9am?"). Labels are how we surface
 *     "Recommended" — the position is unchanged.
 *
 * Determinism:
 *   • Same inputs → same outputs. We pick at most one "recommended"
 *     per ranking call (the highest-scoring slot, breaking ties by
 *     earliest time).
 */

import { scoreSlot } from "./scoreSlot";
import type {
  CustomerPreferenceProfile,
  FocusRules,
  ScoredSlot,
  SlotLabel,
} from "./types";

export type RankSlotsInput = {
  /** Slots as ISO UTC strings — exactly what getAvailableSlots returns. */
  slots: string[];
  /** Service duration in minutes (from services row). */
  durationMinutes: number;
  /** Staff IANA timezone (from users.timezone). */
  staffTimezone: string;
  /** Customer IANA timezone (optional). */
  customerTimezone?: string;
  /** Today's working window for the staff (UTC). Used by end-of-day
   *  fatigue scoring. Passed by the orchestrator. */
  workingWindow: { start: Date; end: Date };
  /** Other bookings (UTC intervals) on the same staff/day. */
  otherBookings: { start: Date; end: Date }[];
  /** Staff's total booking count on this date — workloadBalance +
   *  dailyDensity factors consume this. */
  staffDailyCount: number;
  /** Resolved focus rules (tenant + staff merged). */
  rules: Required<FocusRules>;
  /** Customer history profile (or null). */
  customerProfile?: CustomerPreferenceProfile;
};

export function rankSlots(input: RankSlotsInput): ScoredSlot[] {
  if (input.slots.length === 0) return [];

  const scored: ScoredSlot[] = input.slots.map((iso) => {
    const slotStart = new Date(iso);
    const score = scoreSlot({
      slotStart,
      durationMinutes: input.durationMinutes,
      staffTimezone: input.staffTimezone,
      customerTimezone: input.customerTimezone,
      workingWindow: input.workingWindow,
      otherBookings: input.otherBookings,
      staffDailyCount: input.staffDailyCount,
      rules: input.rules,
      customerProfile: input.customerProfile,
    });
    return {
      time: iso,
      score: score.total,
      labels: [],
      breakdown: score.breakdown,
    };
  });

  // ─── Label assignment ────────────────────────────────────────────
  // "recommended" → top-scoring slot, deterministically tied by
  //                 earliest time. Only ONE slot ever gets it per
  //                 ranking call.
  // "best_availability" → top 25th-percentile by score (max 3 labels)
  // "fastest_confirmation" → earliest slot in the day (when score is
  //                 also reasonable, ≥60).

  const sortedByScore = [...scored]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      if (b.s.score !== a.s.score) return b.s.score - a.s.score;
      // Tiebreak by earliest start time → keeps "recommended" stable
      // when multiple slots score equally.
      return a.s.time.localeCompare(b.s.time);
    });

  // recommended — single winner.
  if (sortedByScore.length > 0 && sortedByScore[0].s.score >= 60) {
    sortedByScore[0].s.labels.push("recommended");
  }

  // best_availability — top 3 (excluding the recommended one). We
  // require score ≥ 75 to avoid labeling mediocre slots as "best".
  const bestThreshold = 75;
  let bestCount = 0;
  for (let i = 1; i < sortedByScore.length && bestCount < 3; i++) {
    if (sortedByScore[i].s.score >= bestThreshold) {
      pushLabel(sortedByScore[i].s.labels, "best_availability");
      bestCount++;
    }
  }

  // fastest_confirmation — the earliest slot in the input order
  // when its score is decent (≥ 60). This is the slot a customer
  // could grab right now to lock in the soonest meeting.
  const earliest = scored[0];
  if (earliest && earliest.score >= 60) {
    pushLabel(earliest.labels, "fastest_confirmation");
  }

  return scored;
}

/** Avoid duplicate labels on a single slot. */
function pushLabel(arr: SlotLabel[], label: SlotLabel): void {
  if (!arr.includes(label)) arr.push(label);
}

/** Cross-day analysis: given an array of (date, scoredSlots) tuples
 *  for a contiguous range, return the date with the highest mean
 *  score — used to mark a "least_busy_day" badge on a calendar UI.
 *
 *  Returns null when there's a tie or no data. */
export function pickLeastBusyDay(
  perDay: { date: string; slots: ScoredSlot[] }[],
): string | null {
  const ranked = perDay
    .filter((d) => d.slots.length > 0)
    .map((d) => ({
      date: d.date,
      meanScore: d.slots.reduce((acc, s) => acc + s.score, 0) / d.slots.length,
      count: d.slots.length,
    }))
    .sort((a, b) => {
      if (b.meanScore !== a.meanScore) return b.meanScore - a.meanScore;
      // Tiebreak by MORE available slots → "least busy" really
      // means "most options".
      return b.count - a.count;
    });
  if (ranked.length < 2) return null;
  if (ranked[0].meanScore === ranked[1].meanScore && ranked[0].count === ranked[1].count) {
    return null; // True tie — surface no badge.
  }
  return ranked[0].date;
}
