/**
 * Phase SMART-2 — reschedule recommendation orchestrator.
 *
 * Given a booking the customer wants to move, returns a short list
 * of SMART-1-ranked alternative slots that:
 *   • Honor the existing booking_rules (min notice, max advance,
 *     business hours, blackouts) — by virtue of going through
 *     getAvailableSlots which already enforces them.
 *   • Score well under the SMART-1 weighted-factor system.
 *   • Are tagged with workflow-level comparison hints (earlier /
 *     same-day / different-day / first-available) so the UI can
 *     prioritize.
 *
 * The orchestrator NEVER books anything — it surfaces options.
 * Booking + slot-correctness remain owned by the existing
 * /api/bookings/[id]/reschedule POST path with its EXCLUDE-constraint
 * transaction. We are READ-ONLY here.
 *
 * Search strategy:
 *   1. Try the booking's CURRENT day first (often the customer just
 *      wants a few hours later).
 *   2. Walk forward up to LOOKAHEAD_DAYS, accumulating scored slots
 *      until we have enough candidates.
 *   3. Rank the union; promote the top 3.
 */

import { addDays, format } from "date-fns";
import { fromZonedTime } from "date-fns-tz";

import { getAvailableSlots } from "@/lib/availability";
import { recommendSlots } from "@/lib/scheduling/intelligence/recommendationEngine";
import type { ScoredSlot } from "@/lib/scheduling/intelligence/types";

import {
  buildHeadline,
  promoteRecommendations,
} from "./workflowRules";
import {
  MAX_RECOMMENDATIONS,
  type WorkflowResult,
} from "./types";

/** How many days forward to scan when collecting candidates. Bounded
 *  so the orchestrator stays fast — the customer rarely wants a
 *  reschedule past 2 weeks out anyway, and the booking rules engine
 *  may cap with max-advance regardless. */
const LOOKAHEAD_DAYS = 7;

/** Minimum scored candidates we collect before stopping the scan.
 *  We want at least this many before picking top-3 so the
 *  comparison is meaningful even on quiet calendars. */
const MIN_CANDIDATES = 10;

export type RescheduleRecommendationInput = {
  /** Customer's currently-booked time. Used as the comparison
   *  anchor for "earlier" vs "same-day" tagging + the headline. */
  currentBookingStart: Date;
  /** Tenant / service / staff scoping. Matches the args
   *  /api/bookings/[id]/reschedule needs to validate the new slot. */
  tenantId: string;
  serviceId: string;
  staffUserId: string;
  /** Staff timezone (IANA). Same value the original booking + slot
   *  endpoint used. */
  timezone: string;
  /** Customer email — engages SMART-1's customer-preference factor.
   *  Optional; safe to omit for non-logged-in flows. */
  customerEmail?: string;
  customerTimezone?: string;
};

export async function buildRescheduleRecommendations(
  input: RescheduleRecommendationInput,
): Promise<WorkflowResult> {
  const generatedAt = new Date().toISOString();

  // Start from "today in the staff's timezone" so we never recommend
  // a past slot. The original booking's date is a hint; if the
  // booking is in the past (unusual but possible during a stale-tab
  // reschedule) we still anchor on today.
  const now = new Date();
  const startDayUtc =
    input.currentBookingStart > now ? input.currentBookingStart : now;

  const allScored: ScoredSlot[] = [];

  for (let dayOffset = 0; dayOffset < LOOKAHEAD_DAYS; dayOffset++) {
    if (allScored.length >= MIN_CANDIDATES * 3) break; // Plenty already.
    const dayUtc = addDays(startDayUtc, dayOffset);
    // Format the date in the staff timezone so we walk YYYY-MM-DD
    // boundaries the customer expects.
    const dateStr = format(
      new Date(dayUtc.toLocaleString("en-US", { timeZone: input.timezone })),
      "yyyy-MM-dd",
    );

    let slots: string[];
    try {
      slots = await getAvailableSlots({
        staffUserId: input.staffUserId,
        serviceId: input.serviceId,
        date: dateStr,
        timezone: input.timezone,
      });
    } catch {
      // Don't let one bad day kill the whole scan.
      continue;
    }

    if (slots.length === 0) continue;

    // Exclude the customer's CURRENT slot — never recommend the
    // same time they're trying to move away from.
    const currentIso = input.currentBookingStart.toISOString();
    const filtered = slots.filter((iso) => iso !== currentIso);
    if (filtered.length === 0) continue;

    let scored: ScoredSlot[];
    try {
      scored = await recommendSlots({
        slots: filtered,
        tenantId: input.tenantId,
        serviceId: input.serviceId,
        staffUserId: input.staffUserId,
        date: dateStr,
        timezone: input.timezone,
        customerEmail: input.customerEmail,
        customerTimezone: input.customerTimezone,
      });
    } catch {
      // SMART-1 orchestrator already handles its own failures, but
      // belt-and-suspenders: degrade to score-less items.
      scored = filtered.map((iso) => ({ time: iso, score: 0, labels: [] }));
    }

    allScored.push(...scored);
  }

  if (allScored.length === 0) {
    return {
      recommendations: [],
      headline: null,
      allScored: [],
      generatedAt,
    };
  }

  // Use staff timezone for the comparison reasoning.
  const recommendations = promoteRecommendations({
    scoredSlots: allScored,
    referenceTime: input.currentBookingStart,
    tz: input.timezone,
    limit: MAX_RECOMMENDATIONS,
  });

  const headline = buildHeadline({
    top: recommendations[0],
    referenceTime: input.currentBookingStart,
    tz: input.timezone,
  });

  return {
    recommendations,
    headline,
    allScored,
    generatedAt,
  };
}

/** Helper: convert a (date string, timezone) tuple to a UTC Date.
 *  Exported for the cancellation recovery module which reuses the
 *  same day-walking logic. */
export function dayStartUtc(date: string, timezone: string): Date {
  return fromZonedTime(`${date}T00:00:00`, timezone);
}
