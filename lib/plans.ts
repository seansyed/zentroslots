/**
 * Plan catalog (Phase 16A).
 *
 * Defines the five commercial tiers (Free, Solo, Pro, Team, Enterprise)
 * with monthly + yearly pricing.
 *
 * Stripe wiring strategy:
 *   - Each plan declares both a MONTHLY and a YEARLY env var key.
 *   - `priceIdFor(planId, interval)` in lib/stripe.ts resolves the
 *     right key at checkout time.
 *   - Legacy `stripePriceEnvVar` (singular, monthly-only) is preserved
 *     as a fallback so existing subscriptions continue billing at
 *     their current Stripe Price without disruption.
 *   - When the operator creates the new Stripe Prices in the Stripe
 *     Dashboard, they paste the IDs into `.env` for the new keys; the
 *     "Upgrade" / "Pay yearly" buttons go live the moment those env
 *     vars are populated. Until then those CTAs render disabled with
 *     a "Stripe price not configured" message — never a fake checkout.
 *
 * Backwards compatibility:
 *   - PlanId still includes the old 4 tiers (free, pro, team,
 *     enterprise) plus the new `solo` entry. All existing callsites
 *     that import `Plan`, `getPlan`, `formatPrice`, `canCreateService`,
 *     `canActivateService` keep working.
 *   - `Plan.priceCents` continues to mean MONTHLY price for legacy
 *     callsites; `priceCentsYearly` is additive.
 */

export type PlanId = "free" | "solo" | "pro" | "team" | "enterprise";
export type BillingInterval = "month" | "year";

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly price in cents. null = "contact us" (no longer used for
   *  Enterprise — Phase 16A made Enterprise self-serve). */
  priceCents: number | null;
  /** Yearly price in cents. null = yearly billing not offered for this
   *  plan (only Free has this). */
  priceCentsYearly: number | null;
  /** Legacy field — kept for callsites that haven't been updated to the
   *  interval-aware `formatPrice`. Always "month" for paid plans, null
   *  for Free + Enterprise-contact-us. */
  interval: "month" | null;
  description: string;
  /** Marketing-style feature bullets. Order matters — first 3-4
   *  bullets appear on the pricing card; the comparison drawer shows
   *  the full list. */
  features: string[];
  limits: {
    maxStaff: number;            // -1 = unlimited
    maxManagers: number;         // -1 = unlimited; 0 = manager role unavailable on this plan
    maxBookingsPerMonth: number; // -1 = unlimited
    // -1 = unlimited; 0 = locations feature unavailable on this
    // plan (page is still accessible with upgrade messaging, but
    // create + edit are gated to 402). Existing rows over the cap
    // are grandfathered — never auto-deleted or hidden.
    maxLocations: number;
    /** -1 = unlimited. Counts ACTIVE services only (Phase 18).
     *  Soft-deleted / inactive services do NOT count — the cap
     *  is a monetization boundary on the bookable surface, not a
     *  storage limit. Existing rows above the cap (e.g. plan
     *  downgrade) are grandfathered: never auto-deleted, but the
     *  next "Add" + isActive flip-to-on are blocked. */
    maxActiveServices: number;
    customBranding: boolean;
    publicProfile: boolean;
    analytics: boolean;
    /** Phase 15D plan gating. Paid plans get 1 custom domain;
     *  Free gets 0. Architecture supports future expansion (cap
     *  bumped here, no callsite changes), but the current
     *  enterprise stance is 1-per-tenant across every paid tier. */
    maxCustomDomains: number;
  };
  /** Legacy env var name (Phase ≤15) — monthly Stripe Price ID.
   *  Phase 16A keeps this as the fallback when the new
   *  `stripePriceEnvMonthly` is unset, so existing subscriptions on
   *  the old prices continue working without any env changes. */
  stripePriceEnvVar?: string;
  /** Phase 16A — new env var keys, one per billing interval. */
  stripePriceEnvMonthly?: string;
  stripePriceEnvYearly?: string;
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    priceCentsYearly: null,
    interval: "month",
    description: "Get started with the essentials.",
    features: [
      "1 staff seat",
      "Up to 3 active services",
      "Unlimited bookings",
      "Public booking page",
      "Basic reminders",
      "Basic communications",
    ],
    limits: {
      maxStaff: 1,
      maxManagers: 0,
      maxBookingsPerMonth: -1,
      maxLocations: 0,
      maxActiveServices: 3,
      customBranding: false,
      publicProfile: true,
      analytics: false,
      maxCustomDomains: 0,
    },
  },
  solo: {
    id: "solo",
    name: "Solo",
    priceCents: 1000,
    priceCentsYearly: 11000,
    interval: "month",
    description: "Run your scheduling like a polished solo operator.",
    features: [
      "1 staff seat",
      "Unlimited services",
      "Unlimited bookings",
      "Branding removal",
      "Analytics access",
      "Email templates",
      "Basic reporting",
    ],
    limits: {
      maxStaff: 1,
      maxManagers: 0,
      maxBookingsPerMonth: -1,
      maxLocations: 1,
      maxActiveServices: -1,
      customBranding: true,
      publicProfile: true,
      analytics: true,
      maxCustomDomains: 1,
    },
    stripePriceEnvMonthly: "STRIPE_PRICE_SOLO_MONTH",
    stripePriceEnvYearly: "STRIPE_PRICE_SOLO_YEAR",
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCents: 3000,
    priceCentsYearly: 33000,
    interval: "month",
    description: "Operate like a team — analytics, automations, and depth.",
    features: [
      "3 staff seats",
      "1 manager seat",
      "Full analytics",
      "Executive dashboard",
      "Reports center",
      "Communications command center",
      "Reminder automations",
      "Advanced branding",
    ],
    limits: {
      maxStaff: 3,
      maxManagers: 1,
      maxBookingsPerMonth: -1,
      maxLocations: 10,
      maxActiveServices: -1,
      customBranding: true,
      publicProfile: true,
      analytics: true,
      maxCustomDomains: 1,
    },
    // Legacy fallback — existing Pro subscriptions continue billing at
    // STRIPE_PRICE_PRO until they're migrated to the new Price IDs.
    stripePriceEnvVar: "STRIPE_PRICE_PRO",
    stripePriceEnvMonthly: "STRIPE_PRICE_PRO_MONTH",
    stripePriceEnvYearly: "STRIPE_PRICE_PRO_YEAR",
  },
  team: {
    id: "team",
    name: "Team",
    priceCents: 10000,
    priceCentsYearly: 110000,
    interval: "month",
    description: "Scale a multi-person workforce with priority support.",
    features: [
      "10 staff seats",
      "1 manager seat",
      "Advanced reporting",
      "Team analytics",
      "Priority support",
      "Advanced communications",
      "Audit history",
      "Export center",
    ],
    limits: {
      maxStaff: 10,
      maxManagers: 1,
      maxBookingsPerMonth: -1,
      maxLocations: -1,
      maxActiveServices: -1,
      customBranding: true,
      publicProfile: true,
      analytics: true,
      maxCustomDomains: 1,
    },
    stripePriceEnvVar: "STRIPE_PRICE_TEAM",
    stripePriceEnvMonthly: "STRIPE_PRICE_TEAM_MONTH",
    stripePriceEnvYearly: "STRIPE_PRICE_TEAM_YEAR",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceCents: 25000,
    priceCentsYearly: 275000,
    interval: "month",
    description: "Self-serve enterprise — SSO, SLA, dedicated onboarding.",
    features: [
      "Unlimited staff",
      "Unlimited managers",
      "SSO / SAML",
      "Enterprise SLA",
      "Dedicated onboarding",
      "Advanced governance",
      "Future automation engine",
      "Advanced audit tooling",
    ],
    limits: {
      maxStaff: -1,
      maxManagers: -1,
      maxBookingsPerMonth: -1,
      maxLocations: -1,
      maxActiveServices: -1,
      customBranding: true,
      publicProfile: true,
      analytics: true,
      maxCustomDomains: 1,
    },
    stripePriceEnvMonthly: "STRIPE_PRICE_ENTERPRISE_MONTH",
    stripePriceEnvYearly: "STRIPE_PRICE_ENTERPRISE_YEAR",
  },
};

export function getPlan(id: string | null | undefined): Plan {
  if (id && (PLANS as Record<string, Plan | undefined>)[id]) {
    return PLANS[id as PlanId];
  }
  return PLANS.free;
}

export function isUnlimited(n: number): boolean {
  return n < 0;
}

/**
 * Format the monthly price as a short display string.
 * Legacy helper — callers that need yearly should use `formatPriceFor`.
 */
export function formatPrice(p: Plan): string {
  if (p.priceCents === null) return "Custom";
  if (p.priceCents === 0) return "Free";
  return `$${(p.priceCents / 100).toFixed(0)}/mo`;
}

/**
 * Phase 16A — interval-aware price formatter. Returns "Free" for the
 * free plan regardless of interval. Returns null when the plan doesn't
 * offer the requested interval (only Free, which has no yearly).
 */
export function formatPriceFor(p: Plan, interval: BillingInterval): string {
  if (p.id === "free") return "Free";
  if (interval === "year") {
    if (p.priceCentsYearly === null) {
      // Falls back to monthly × 12 displayed as the per-year total.
      // No plan currently uses this fallback — kept defensive.
      if (p.priceCents === null) return "Custom";
      return `$${((p.priceCents * 12) / 100).toFixed(0)}/yr`;
    }
    return `$${(p.priceCentsYearly / 100).toFixed(0)}/yr`;
  }
  if (p.priceCents === null) return "Custom";
  return `$${(p.priceCents / 100).toFixed(0)}/mo`;
}

/**
 * Phase 16A — compute the yearly savings expressed as months saved.
 * Example: $30/mo × 12 = $360, yearly = $330 → 1 month of savings.
 * Returns 0 when there's no savings (or no yearly price).
 */
export function yearlyMonthsSaved(p: Plan): number {
  if (p.priceCents === null || p.priceCents === 0) return 0;
  if (p.priceCentsYearly === null) return 0;
  const monthlyYearTotal = p.priceCents * 12;
  const saved = monthlyYearTotal - p.priceCentsYearly;
  if (saved <= 0) return 0;
  return Math.round(saved / p.priceCents);
}

// ─── Plan capability helpers (Phase 18) ───────────────────────────
//
// Shared check used by every "can this tenant create another X?"
// path — server route handlers AND client UI gating. Keeping the
// rule in ONE place means UI + API can never drift. When a future
// plan adds a new cap (e.g. maxActiveDepartments), add a new helper
// here rather than scattering `plan.id === "free"` checks across
// routes.

export type CapabilityResult = {
  /** true when the action is allowed under the current plan + usage */
  allowed: boolean;
  /** Human-friendly reason when allowed=false. Safe to surface to
   *  the operator (no internal jargon). */
  reason: string | null;
  /** Capacity snapshot for the UI to render an honest "used / max"
   *  chip. `max=-1` means unlimited (UI should hide the chip). */
  cap: { used: number; max: number; remaining: number; atCap: boolean };
};

/** Service-cap capability check. `activeCount` = the tenant's
 *  current count of services where `is_active=1`. The cap is
 *  defined by `plan.limits.maxActiveServices`. Unlimited plans
 *  always pass.
 *
 *  Returns the rich CapabilityResult so both the API route can
 *  decide whether to 403 AND the client can render the same
 *  text/state without duplicating the logic. */
export function canCreateService(plan: Plan, activeCount: number): CapabilityResult {
  const max = plan.limits.maxActiveServices;
  if (isUnlimited(max)) {
    return {
      allowed: true,
      reason: null,
      cap: { used: activeCount, max: -1, remaining: -1, atCap: false },
    };
  }
  const remaining = Math.max(0, max - activeCount);
  const atCap = activeCount >= max;
  return {
    allowed: !atCap,
    reason: atCap
      ? `${plan.name} workspaces support up to ${max} active services. Upgrade your plan or archive an existing service to add another.`
      : null,
    cap: { used: activeCount, max, remaining, atCap },
  };
}

/** Activation capability check. Same cap, different trigger: the
 *  operator toggles a previously-inactive service back to active.
 *  Functionally identical to canCreateService today, but kept as a
 *  distinct entry point so future flows (e.g. soft-delete restore)
 *  can refine the messaging without changing creates. */
export function canActivateService(plan: Plan, activeCount: number): CapabilityResult {
  const base = canCreateService(plan, activeCount);
  if (base.allowed) return base;
  return {
    ...base,
    reason: `${plan.name} workspaces support up to ${plan.limits.maxActiveServices} active services. Archive another service before reactivating this one, or upgrade your plan.`,
  };
}
