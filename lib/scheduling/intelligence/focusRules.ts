/**
 * Phase SMART-1 — focus rules resolver.
 *
 * Three-layer precedence:
 *   1. Staff override (users.focus_rules)
 *   2. Tenant default (tenants.focus_rules)
 *   3. Hardcoded engine baseline (DEFAULT_FOCUS_RULES)
 *
 * Each layer is OPTIONAL and may set ANY subset of fields. The
 * resolver merges field-by-field — a staff member who set ONLY
 * dailySoftCap inherits everything else from the tenant defaults
 * which in turn inherit unset fields from the engine baseline.
 *
 * This is a pure function — DB reads happen in the orchestrator.
 */

import type { FocusRules } from "./types";

/** Engine baseline — chosen to be neutral defaults that match
 *  most knowledge-work + appointment-services use cases. Documented
 *  per-field so admins can reason about overrides. */
export const DEFAULT_FOCUS_RULES: Required<FocusRules> = {
  // Most cultures eat lunch in the 12:00-13:00 window. The lunch
  // avoidance penalty is intentionally LIGHT (10pt) so the slot is
  // still rendered — staff may willingly take a lunch meeting.
  lunchHours: { start: 12, end: 13 },
  // Don't push customers into the final half-hour of the day —
  // staff are usually winding down + late-start friction.
  endOfDayDecayMin: 30,
  // After 4 consecutive booked hours, the next slot loses points
  // for back-to-back overload protection.
  maxConsecutiveHours: 4,
  // Reward slots that leave at least 10 min between bookings —
  // fragmenting the day with 1-min gaps is operationally worse.
  minBufferMinutes: 10,
  // 8 confirmed bookings/day is the soft cap before workloadBalance
  // penalizes further additions. Hard cap belongs in working hours
  // + rate limits, not here.
  dailySoftCap: 8,
  // No quiet hours by default — staff opt in by editing the rule.
  quietHours: [],
  // Standard 9-to-6 customer-comfort window. Slots outside get a
  // (small) penalty so we naturally prefer business-hours bookings.
  customerPreferredHours: { start: 9, end: 18 },
};

/** Merge a partial override on top of a base. Field-by-field — no
 *  deep merge for arrays/objects (a partial override of quietHours
 *  REPLACES, doesn't append, by design). */
function mergeOne(
  base: Required<FocusRules>,
  override: FocusRules | null | undefined,
): Required<FocusRules> {
  if (!override) return base;
  return {
    lunchHours: override.lunchHours ?? base.lunchHours,
    endOfDayDecayMin:
      typeof override.endOfDayDecayMin === "number"
        ? override.endOfDayDecayMin
        : base.endOfDayDecayMin,
    maxConsecutiveHours:
      typeof override.maxConsecutiveHours === "number"
        ? override.maxConsecutiveHours
        : base.maxConsecutiveHours,
    minBufferMinutes:
      typeof override.minBufferMinutes === "number"
        ? override.minBufferMinutes
        : base.minBufferMinutes,
    dailySoftCap:
      typeof override.dailySoftCap === "number"
        ? override.dailySoftCap
        : base.dailySoftCap,
    quietHours: override.quietHours ?? base.quietHours,
    customerPreferredHours:
      override.customerPreferredHours ?? base.customerPreferredHours,
  };
}

/** Resolve the effective focus rules for a (tenant, staff) pair.
 *  Either input may be null/undefined; the resolver still returns
 *  a fully-populated rule set so downstream scorers never have to
 *  null-check. */
export function resolveFocusRules(args: {
  tenantRules: FocusRules | null | undefined;
  staffRules: FocusRules | null | undefined;
}): Required<FocusRules> {
  const withTenant = mergeOne(DEFAULT_FOCUS_RULES, args.tenantRules);
  const withStaff = mergeOne(withTenant, args.staffRules);
  return withStaff;
}

/** Type guard — accepts arbitrary JSONB output from the DB and
 *  returns a normalized FocusRules (or null if the JSONB shape is
 *  unrecognizable). Defensive against admin UIs that might write
 *  malformed values. */
export function parseFocusRulesFromJson(raw: unknown): FocusRules | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const out: FocusRules = {};

  if (
    obj.lunchHours &&
    typeof obj.lunchHours === "object" &&
    typeof (obj.lunchHours as { start?: unknown }).start === "number" &&
    typeof (obj.lunchHours as { end?: unknown }).end === "number"
  ) {
    out.lunchHours = obj.lunchHours as { start: number; end: number };
  }
  if (typeof obj.endOfDayDecayMin === "number") {
    out.endOfDayDecayMin = obj.endOfDayDecayMin;
  }
  if (typeof obj.maxConsecutiveHours === "number") {
    out.maxConsecutiveHours = obj.maxConsecutiveHours;
  }
  if (typeof obj.minBufferMinutes === "number") {
    out.minBufferMinutes = obj.minBufferMinutes;
  }
  if (typeof obj.dailySoftCap === "number") {
    out.dailySoftCap = obj.dailySoftCap;
  }
  if (Array.isArray(obj.quietHours)) {
    const cleaned = (obj.quietHours as unknown[]).filter(
      (q): q is { start: number; end: number } =>
        !!q &&
        typeof q === "object" &&
        typeof (q as { start?: unknown }).start === "number" &&
        typeof (q as { end?: unknown }).end === "number",
    );
    out.quietHours = cleaned;
  }
  if (
    obj.customerPreferredHours &&
    typeof obj.customerPreferredHours === "object" &&
    typeof (obj.customerPreferredHours as { start?: unknown }).start === "number" &&
    typeof (obj.customerPreferredHours as { end?: unknown }).end === "number"
  ) {
    out.customerPreferredHours = obj.customerPreferredHours as {
      start: number;
      end: number;
    };
  }
  return out;
}
