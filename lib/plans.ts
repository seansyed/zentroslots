/**
 * Plan catalog. Defines the four commercial tiers and what they include.
 * Stripe Price IDs come from env so the same code works in test + live.
 */

export type PlanId = "free" | "pro" | "team" | "enterprise";

export type Plan = {
  id: PlanId;
  name: string;
  priceCents: number | null; // null = "contact us"
  interval: "month" | null;
  description: string;
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
  };
  stripePriceEnvVar?: string;
};

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    interval: "month",
    description: "Get started with the essentials.",
    features: ["1 staff member", "Up to 3 active services", "Unlimited bookings", "Public booking page"],
    limits: { maxStaff: 1, maxManagers: 0, maxBookingsPerMonth: -1, maxLocations: 0, maxActiveServices: 3, customBranding: false, publicProfile: true, analytics: false },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCents: 1900,
    interval: "month",
    description: "For growing teams.",
    features: ["Up to 5 staff", "2 manager seats", "Unlimited services", "1,000 bookings / month", "Custom branding", "Analytics dashboard"],
    limits: { maxStaff: 5, maxManagers: 2, maxBookingsPerMonth: 1000, maxLocations: 10, maxActiveServices: -1, customBranding: true, publicProfile: true, analytics: true },
    stripePriceEnvVar: "STRIPE_PRICE_PRO",
  },
  team: {
    id: "team",
    name: "Team",
    priceCents: 4900,
    interval: "month",
    description: "Scale without limits.",
    features: ["Unlimited staff", "5 manager seats", "Unlimited services", "Unlimited bookings", "Custom branding", "Analytics", "Priority support"],
    limits: { maxStaff: -1, maxManagers: 5, maxBookingsPerMonth: -1, maxLocations: -1, maxActiveServices: -1, customBranding: true, publicProfile: true, analytics: true },
    stripePriceEnvVar: "STRIPE_PRICE_TEAM",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceCents: null,
    interval: null,
    description: "SSO, SLAs, dedicated support.",
    features: ["Everything in Team", "Unlimited manager seats", "SSO / SAML", "99.9% uptime SLA", "Dedicated CSM"],
    limits: { maxStaff: -1, maxManagers: -1, maxBookingsPerMonth: -1, maxLocations: -1, maxActiveServices: -1, customBranding: true, publicProfile: true, analytics: true },
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

export function formatPrice(p: Plan): string {
  if (p.priceCents === null) return "Custom";
  if (p.priceCents === 0) return "Free";
  return `$${(p.priceCents / 100).toFixed(0)}/mo`;
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
