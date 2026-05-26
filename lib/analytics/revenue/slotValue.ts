/**
 * Phase SMART-4 — slot value scorer.
 *
 * PURE function. Given a slot's context (price, demand, lead time)
 * returns a 0..100 value score + an optional UI signal that the
 * booking flow can render as a chip:
 *
 *   "premium"      — price ≥ 1.5× workspace median + has demand
 *   "popular"      — historical bookings ≥ 1.5× staff mean
 *   "high_demand"  — bookings ≥ 2× staff mean
 *   "fast_booking" — lead time ≤ 4h (same-day-ish)
 *   null           — nothing exceeds the surfacing threshold
 *
 * Deterministic: same inputs → same outputs. No Math.random, no
 * Date.now (callers pass `now` via input).
 */

import type {
  SlotValueAssessment,
  SlotValueInput,
  SlotValueSignal,
} from "./types";

/** Multiplier above the workspace median price that triggers
 *  "premium" tagging. 1.5× is the standard "noticeably above
 *  baseline" threshold. */
const PREMIUM_PRICE_MULTIPLIER = 1.5;

/** Multiplier above the staff's mean bookings/cell that triggers
 *  "popular". */
const POPULAR_DEMAND_MULTIPLIER = 1.5;

/** Multiplier for "high_demand" — significantly above mean. */
const HIGH_DEMAND_MULTIPLIER = 2.0;

/** Lead-hour threshold for "fast_booking". */
const FAST_BOOKING_LEAD_HOURS = 4;

/** Minimum sample size before historical demand is treated as
 *  signal. Below this, demand factors don't fire. */
const MIN_DEMAND_SAMPLE = 3;

export function scoreSlotValue(input: SlotValueInput): SlotValueAssessment {
  const reasons: string[] = [];
  let score = 0;
  let signal: SlotValueSignal = null;

  // ─── Price component ────────────────────────────────────────────
  // Compare to workspace median price. Premium = ≥ 1.5× median.
  // Score contribution caps at 40pt.
  const medianPrice = Math.max(1, input.workspaceMedianPriceCents); // avoid /0
  const priceRatio = input.servicePriceCents / medianPrice;
  if (input.servicePriceCents > 0) {
    if (priceRatio >= PREMIUM_PRICE_MULTIPLIER) {
      score += 40;
      reasons.push("Premium-priced service");
    } else if (priceRatio >= 1.0) {
      score += 20;
    } else {
      score += 10;
    }
  }

  // ─── Demand component ──────────────────────────────────────────
  // Compare to staff mean. Above 2× = high_demand; above 1.5× = popular.
  // Requires a meaningful sample size — single-booking history doesn't
  // produce a "popular" tag for a brand-new staff member.
  const demandRatio =
    input.staffMeanBookings > 0
      ? input.historicalBookings / input.staffMeanBookings
      : 0;
  if (input.historicalBookings >= MIN_DEMAND_SAMPLE) {
    if (demandRatio >= HIGH_DEMAND_MULTIPLIER) {
      score += 40;
      signal = "high_demand";
      reasons.push(
        `High demand — ${input.historicalBookings} historical bookings in this slot vs ${Math.round(input.staffMeanBookings)} average`,
      );
    } else if (demandRatio >= POPULAR_DEMAND_MULTIPLIER) {
      score += 25;
      signal = "popular";
      reasons.push(
        `Popular slot — ${input.historicalBookings} historical bookings`,
      );
    } else if (demandRatio >= 1.0) {
      score += 15;
    }
  }

  // ─── Lead-time / fast-booking component ────────────────────────
  // Same-day or short-lead — useful for "book now" affordances.
  if (input.leadHours <= FAST_BOOKING_LEAD_HOURS && input.leadHours >= 0) {
    score += 20;
    // Only surface as the signal if nothing more specific was set.
    if (signal === null) {
      signal = "fast_booking";
      reasons.push("Same-day availability");
    }
  }

  // ─── Premium signal override ────────────────────────────────────
  // Premium price + meaningful demand = "premium" wins over "popular".
  if (
    priceRatio >= PREMIUM_PRICE_MULTIPLIER &&
    input.historicalBookings >= MIN_DEMAND_SAMPLE &&
    demandRatio >= 1.0
  ) {
    signal = "premium";
  }

  // Clamp.
  score = Math.max(0, Math.min(100, score));

  return {
    score,
    signal,
    reasons: reasons.slice(0, 2),
  };
}

/** Tunables exposed for tests + admin UIs. */
export const _slotValueTunables = {
  PREMIUM_PRICE_MULTIPLIER,
  POPULAR_DEMAND_MULTIPLIER,
  HIGH_DEMAND_MULTIPLIER,
  FAST_BOOKING_LEAD_HOURS,
  MIN_DEMAND_SAMPLE,
} as const;
