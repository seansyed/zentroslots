import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { capabilitySnapshot } from "@/lib/billing/capabilities";
import { getPlan } from "@/lib/plans";

/**
 * GET /api/tenant/capabilities
 *
 * Single source of truth for the client. Returns the caller tenant's:
 *   - resolved plan (id + name + monthly/yearly price metadata)
 *   - per-capability check (allowed | currentPlan | requiredPlan | reason)
 *   - quota-style limits (staff seats, locations, custom domains, etc.)
 *   - billing state (active flag + Stripe subscription status)
 *
 * Why this endpoint exists:
 *   Phase 16K placed plan-aware locks throughout the Feature Controls
 *   UI by duplicating the capability matrix on the client. That was
 *   fine for the initial ship but means the UI can drift from the
 *   server's enforcement rules. This endpoint exposes the same matrix
 *   the server uses (lib/billing/capabilities.ts) so the UI never
 *   has to reason about plan tiers locally — fetch this once on
 *   workspace load, render lock states from `capabilities[cap].allowed`.
 *
 * Tenant isolation: derived from the authenticated user's tenantId.
 * No tenantId query parameter is accepted — there is no cross-tenant
 * lookup surface here.
 *
 * Caching: this is a read-only snapshot but plans change infrequently
 * and the payload is small. We mark force-dynamic so clients always
 * see the truth right after a plan upgrade/downgrade — no stale Pro
 * banners after a downgrade. Clients should cache in-memory for the
 * page session.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireUser();

    const tenantRow = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: {
        id: true,
        currentPlan: true,
        subscriptionStatus: true,
        active: true,
        trialEnd: true,
      },
    });

    // Defensive: if the tenant row is missing (impossible under FK but
    // we never want to crash the client), fall back to the free plan.
    const plan = getPlan(tenantRow?.currentPlan);
    const capabilities = capabilitySnapshot(plan);

    return NextResponse.json({
      plan: {
        id: plan.id,
        name: plan.name,
        priceCents: plan.priceCents,
        priceCentsYearly: plan.priceCentsYearly,
      },
      limits: plan.limits,
      capabilities,
      billing: {
        active: tenantRow?.active ?? true,
        subscriptionStatus: tenantRow?.subscriptionStatus ?? null,
        trialEnd: tenantRow?.trialEnd ?? null,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
