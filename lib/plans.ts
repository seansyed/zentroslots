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
    maxBookingsPerMonth: number; // -1 = unlimited
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
    features: ["1 staff member", "50 bookings / month", "Public booking page"],
    limits: { maxStaff: 1, maxBookingsPerMonth: 50, customBranding: false, publicProfile: true, analytics: false },
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCents: 1900,
    interval: "month",
    description: "For growing teams.",
    features: ["Up to 5 staff", "1,000 bookings / month", "Custom branding", "Analytics dashboard"],
    limits: { maxStaff: 5, maxBookingsPerMonth: 1000, customBranding: true, publicProfile: true, analytics: true },
    stripePriceEnvVar: "STRIPE_PRICE_PRO",
  },
  team: {
    id: "team",
    name: "Team",
    priceCents: 4900,
    interval: "month",
    description: "Scale without limits.",
    features: ["Unlimited staff", "Unlimited bookings", "Custom branding", "Analytics", "Priority support"],
    limits: { maxStaff: -1, maxBookingsPerMonth: -1, customBranding: true, publicProfile: true, analytics: true },
    stripePriceEnvVar: "STRIPE_PRICE_TEAM",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    priceCents: null,
    interval: null,
    description: "SSO, SLAs, dedicated support.",
    features: ["Everything in Team", "SSO / SAML", "99.9% uptime SLA", "Dedicated CSM"],
    limits: { maxStaff: -1, maxBookingsPerMonth: -1, customBranding: true, publicProfile: true, analytics: true },
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
