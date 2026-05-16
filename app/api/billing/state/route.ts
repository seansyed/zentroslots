import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { getTenantUsage } from "@/lib/quotas";
import { isStripeConfigured } from "@/lib/stripe";
import { getPlan } from "@/lib/plans";

export async function GET() {
  try {
    const user = await requireUser();
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
    if (!tenant) throw new Error("Tenant not found");

    const usage = await getTenantUsage(user.tenantId);
    const plan = getPlan(tenant.currentPlan);

    return NextResponse.json({
      tenant: {
        name: tenant.name,
        slug: tenant.slug,
        billingEmail: tenant.billingEmail ?? user.email,
        currentPlan: tenant.currentPlan,
        subscriptionStatus: tenant.subscriptionStatus,
        trialEnd: tenant.trialEnd,
        stripeCustomerId: tenant.stripeCustomerId,
        stripeSubscriptionId: tenant.stripeSubscriptionId,
      },
      plan: { id: plan.id, name: plan.name, limits: plan.limits },
      usage,
      stripeConfigured: isStripeConfigured(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
