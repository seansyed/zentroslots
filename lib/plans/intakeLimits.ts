/**
 * Wave I — per-plan intake limits resolver.
 *
 * Single chokepoint that both the form-save APIs and the admin builder
 * UI consume. Keeps the Free-tier type whitelist in one place.
 */

import { FREE_TIER_TYPE_WHITELIST, type PlanIntakeLimits } from "@/lib/intake";
import { getPlan } from "@/lib/plans";

export function resolveIntakeLimits(planId: string | null | undefined): PlanIntakeLimits {
  const plan = getPlan(planId);
  return {
    maxIntakeFields: plan.limits.maxIntakeFields,
    typeWhitelist: plan.id === "free" ? FREE_TIER_TYPE_WHITELIST : null,
  };
}
