import { desc, isNotNull, or } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";
import { csvResponse, toCsv } from "@/lib/csv";

export async function GET() {
  try {
    await requireSuperAdmin();
    const rows = await db
      .select({
        tenantId: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        plan: tenants.currentPlan,
        status: tenants.subscriptionStatus,
        stripeCustomerId: tenants.stripeCustomerId,
        stripeSubscriptionId: tenants.stripeSubscriptionId,
        trialEnd: tenants.trialEnd,
        billingEmail: tenants.billingEmail,
        active: tenants.active,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      // "subscriptions" export = anything that has any billing relationship,
      // including trialing free plans (Stripe customer exists). Pure-free
      // tenants with no Stripe footprint are excluded — they're not subs.
      .where(or(isNotNull(tenants.subscriptionStatus), isNotNull(tenants.stripeCustomerId))!)
      .orderBy(desc(tenants.createdAt));

    const csv = toCsv(rows, [
      { key: "tenantId", header: "tenant_id" },
      { key: "name", header: "name" },
      { key: "slug", header: "slug" },
      { key: "plan", header: "plan" },
      { key: "status", header: "subscription_status" },
      { key: "stripeCustomerId", header: "stripe_customer_id" },
      { key: "stripeSubscriptionId", header: "stripe_subscription_id" },
      { key: "trialEnd", header: "trial_end" },
      { key: "billingEmail", header: "billing_email" },
      { key: "active", header: "active" },
      { key: "createdAt", header: "created_at" },
    ]);
    return csvResponse(`subscriptions-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  } catch (err) {
    return errorResponse(err);
  }
}
