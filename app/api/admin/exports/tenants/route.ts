import { desc, sql } from "drizzle-orm";

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
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        plan: tenants.currentPlan,
        active: tenants.active,
        subscriptionStatus: tenants.subscriptionStatus,
        billingEmail: tenants.billingEmail,
        stripeCustomerId: tenants.stripeCustomerId,
        stripeSubscriptionId: tenants.stripeSubscriptionId,
        trialEnd: tenants.trialEnd,
        onboardingCompletedAt: tenants.onboardingCompletedAt,
        userCount: sql<number>`(SELECT COUNT(*)::int FROM users WHERE users.tenant_id = ${tenants.id})`,
        bookingCount: sql<number>`(SELECT COUNT(*)::int FROM bookings WHERE bookings.tenant_id = ${tenants.id})`,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .orderBy(desc(tenants.createdAt));

    const csv = toCsv(rows, [
      { key: "id", header: "tenant_id" },
      { key: "name", header: "name" },
      { key: "slug", header: "slug" },
      { key: "plan", header: "plan" },
      { key: "active", header: "active" },
      { key: "subscriptionStatus", header: "subscription_status" },
      { key: "billingEmail", header: "billing_email" },
      { key: "stripeCustomerId", header: "stripe_customer_id" },
      { key: "stripeSubscriptionId", header: "stripe_subscription_id" },
      { key: "trialEnd", header: "trial_end" },
      { key: "onboardingCompletedAt", header: "onboarding_completed_at" },
      { key: "userCount", header: "user_count" },
      { key: "bookingCount", header: "booking_count" },
      { key: "createdAt", header: "created_at" },
    ]);
    return csvResponse(`tenants-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  } catch (err) {
    return errorResponse(err);
  }
}
