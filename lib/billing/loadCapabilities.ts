/**
 * Server-side capability loader (Phase 3 of plan enforcement).
 *
 * Same payload shape as `GET /api/tenant/capabilities` — server pages
 * call this helper to fetch capabilities once, then pass the result
 * down to `<CapabilityProvider initial={...}>` so the client tree is
 * hydrated synchronously. Zero client fetch on mount = zero flicker.
 *
 * Backend is the only source of truth. The route handler and this
 * loader both read `capabilitySnapshot(plan)` — they cannot drift.
 *
 * Tenant isolation: caller is responsible. This helper takes a
 * tenantId. It does NOT call `requireUser()` because server pages
 * already authenticate before knowing which tenant to load. Passing
 * an arbitrary tenantId here is therefore safe — the page would not
 * have reached this point without auth.
 */
import { eq } from "drizzle-orm";

import { db as defaultDb } from "@/db/client";
import { tenants } from "@/db/schema";
import { capabilitySnapshot, type CapabilityCheck, type Capability } from "@/lib/billing/capabilities";
import { getPlan, type PlanId } from "@/lib/plans";

export type CapabilityPayload = {
  plan: {
    id: PlanId;
    name: string;
    priceCents: number | null;
    priceCentsYearly: number | null;
  };
  limits: {
    maxStaff: number;
    maxManagers: number;
    maxBookingsPerMonth: number;
    maxLocations: number;
    maxActiveServices: number;
    customBranding: boolean;
    publicProfile: boolean;
    analytics: boolean;
    maxCustomDomains: number;
  };
  capabilities: Record<Capability, CapabilityCheck>;
  billing: {
    active: boolean;
    subscriptionStatus: string | null;
    /** ISO string for serialization safety across the server→client
     *  boundary. The client doesn't need a Date for any of the current
     *  consumers; ISO is enough. */
    trialEnd: string | null;
  };
};

/**
 * Load the capability payload for a tenant. Returns the same shape
 * as the API route. Defensive: a missing tenant row falls back to
 * the free plan rather than throwing — the client always renders
 * SOMETHING and locked-by-default is the safe outcome.
 */
export async function loadCapabilitiesForTenant(
  tenantId: string,
  db: typeof defaultDb = defaultDb,
): Promise<CapabilityPayload> {
  const tenantRow = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: {
      id: true,
      currentPlan: true,
      subscriptionStatus: true,
      active: true,
      trialEnd: true,
    },
  });
  const plan = getPlan(tenantRow?.currentPlan);
  return {
    plan: {
      id: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      priceCentsYearly: plan.priceCentsYearly,
    },
    limits: plan.limits,
    capabilities: capabilitySnapshot(plan),
    billing: {
      active: tenantRow?.active ?? true,
      subscriptionStatus: tenantRow?.subscriptionStatus ?? null,
      trialEnd: tenantRow?.trialEnd ? tenantRow.trialEnd.toISOString() : null,
    },
  };
}
