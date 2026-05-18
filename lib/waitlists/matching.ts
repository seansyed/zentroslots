/**
 * Pure matching predicates for the waitlist engine.
 *
 * `rankCandidate` returns a numeric priority — LOWER is better:
 *
 *   0   exact date AND time-range match
 *   1   exact date match (any time)
 *   2   time-range match (no date pref, or any-date)
 *   3   service-level fallback (any date, any range)
 *   99  ineligible (date set and doesn't match)
 *
 * Within the same rank, FIFO ordering is enforced by the caller
 * sorting by createdAt ASC.
 *
 * Time-range buckets (in the staff's local timezone):
 *   morning   : 05:00 - 11:59
 *   afternoon : 12:00 - 16:59
 *   evening   : 17:00 - 22:59
 *   any       : matches anything (skipped if customer cares)
 *
 * Pure — no DB, no Date inputs that wrap timezones. The caller resolves
 * "what date is this slot, in what timezone, what hour bucket" once
 * and passes scalar inputs.
 */

import type { WaitlistTimeRange } from "./types";

export type Candidate = {
  preferredDate: string | null;
  preferredTimeRange: WaitlistTimeRange;
};

export type SlotInfo = {
  /** "YYYY-MM-DD" in staff's local TZ. */
  date: string;
  /** 0..23, hour in staff's local TZ. */
  hour: number;
};

export type CandidateRank = 0 | 1 | 2 | 3 | 99;

export function hourToRange(hour: number): WaitlistTimeRange {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 23) return "evening";
  return "any"; // late-night / pre-dawn — let any-range customers match
}

export function rankCandidate(c: Candidate, slot: SlotInfo): CandidateRank {
  const slotRange = hourToRange(slot.hour);

  // Date check first — if the customer set a preferred date and it
  // doesn't match, they're ineligible for this slot (don't notify
  // someone about a date they didn't ask for).
  if (c.preferredDate && c.preferredDate !== slot.date) {
    return 99;
  }

  const rangeMatches =
    c.preferredTimeRange === "any" || c.preferredTimeRange === slotRange;

  if (c.preferredDate === slot.date && rangeMatches && c.preferredTimeRange !== "any") {
    return 0; // exact date + specific range
  }
  if (c.preferredDate === slot.date) {
    return 1; // exact date, range is "any" (still a great match)
  }
  // No preferred date.
  if (c.preferredTimeRange !== "any" && rangeMatches) {
    return 2; // time-range match (any date)
  }
  if (c.preferredTimeRange === "any") {
    return 3; // service-level fallback — they take anything
  }
  // Time range set but doesn't match (and no date) — ineligible.
  return 99;
}

/**
 * Sort candidates by (rank ASC, priority DESC, createdAt ASC).
 * The caller hydrates `rank` for each candidate before sorting.
 */
export type RankedCandidate = Candidate & {
  rank: CandidateRank;
  priority: number;
  createdAt: Date;
};

export function pickBest(candidates: RankedCandidate[]): RankedCandidate | null {
  const eligible = candidates.filter((c) => c.rank !== 99);
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return eligible[0];
}
