/**
 * Resolve the EFFECTIVE booking rule for a (tenant, service, location).
 *
 * Hierarchy (most specific wins):
 *   1. service-specific rule
 *   2. location-specific rule
 *   3. tenant default rule
 *   4. legacy services.{minNoticeMinutes,maxAdvanceDays} as fallbacks
 *      for the two overlapping fields ONLY. No legacy equivalent for
 *      the other rule fields (caps/cooldown/blackouts/business hours).
 *
 * If no booking_rules row exists, ruleFound=false and we still return
 * an EffectiveRule populated from the legacy service fields. Caller
 * sees the same input shape either way.
 *
 * Never throws. Tenant isolation: every DB read is filtered by
 * tenantId from the caller.
 */
import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "@/db/client";
import { bookingRules, services } from "@/db/schema";

import type { BusinessHoursConfig, EffectiveRule } from "./types";

export async function resolveBookingRules(input: {
  tenantId: string;
  serviceId: string;
  locationId?: string | null;
}): Promise<EffectiveRule> {
  // Fetch every candidate rule (max 3 — one per scope bucket) plus
  // the legacy service fields in parallel.
  const [candidateRules, service] = await Promise.all([
    db
      .select()
      .from(bookingRules)
      .where(
        and(
          eq(bookingRules.tenantId, input.tenantId),
          or(
            eq(bookingRules.serviceId, input.serviceId),
            input.locationId
              ? eq(bookingRules.locationId, input.locationId)
              : isNull(bookingRules.locationId),
            and(isNull(bookingRules.serviceId), isNull(bookingRules.locationId))
          )
        )
      ),
    db.query.services.findFirst({
      where: and(eq(services.id, input.serviceId), eq(services.tenantId, input.tenantId)),
    }),
  ]);

  // Rank candidates: service > location > tenant default.
  const rank = (r: typeof bookingRules.$inferSelect): number => {
    if (r.serviceId === input.serviceId) return 0;
    if (input.locationId && r.locationId === input.locationId) return 1;
    if (r.serviceId === null && r.locationId === null) return 2;
    return 99;
  };
  const sorted = [...candidateRules].sort((a, b) => rank(a) - rank(b));
  const winner = sorted[0] ?? null;

  // Build the effective rule. Legacy service fields are the safety
  // net for notice + advance when no rule sets them.
  const legacyNotice = service?.minNoticeMinutes ?? null;
  const legacyAdvance = service?.maxAdvanceDays ?? null;

  if (!winner) {
    return {
      source: legacyNotice !== null || legacyAdvance !== null ? "service_fields" : "none",
      ruleFound: false,
      enabled: true,
      minNoticeMinutes: legacyNotice,
      maxAdvanceDays: legacyAdvance,
      maxBookingsPerDay: null,
      maxBookingsPerCustomerPerDay: null,
      maxConcurrentBookings: null,
      cooldownMinutes: null,
      blackoutDates: [],
      requireBusinessHours: false,
      businessHours: {},
    };
  }

  const blackoutDates = Array.isArray(winner.blackoutDates)
    ? (winner.blackoutDates as string[]).filter((s) => typeof s === "string")
    : [];
  const businessHours: BusinessHoursConfig =
    winner.businessHours && typeof winner.businessHours === "object" && !Array.isArray(winner.businessHours)
      ? (winner.businessHours as BusinessHoursConfig)
      : {};

  // Source label: service > location > tenant default.
  const source: EffectiveRule["source"] =
    winner.serviceId === input.serviceId
      ? "service"
      : winner.locationId !== null
      ? "location"
      : "tenant";

  return {
    source,
    ruleFound: true,
    enabled: winner.enabled,
    // Rule values override legacy. NULL on the rule means "fall back
    // to legacy" — admins can clear a field without deleting the rule.
    minNoticeMinutes: winner.minNoticeMinutes ?? legacyNotice,
    maxAdvanceDays: winner.maxAdvanceDays ?? legacyAdvance,
    maxBookingsPerDay: winner.maxBookingsPerDay,
    maxBookingsPerCustomerPerDay: winner.maxBookingsPerCustomerPerDay,
    maxConcurrentBookings: winner.maxConcurrentBookings,
    cooldownMinutes: winner.cooldownMinutes,
    blackoutDates,
    requireBusinessHours: winner.requireBusinessHours,
    businessHours,
  };
}
