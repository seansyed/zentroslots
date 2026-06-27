import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, tenantPhoneSettings, tenantPhoneNumbers } from "@/db/schema";
import { errorResponse } from "@/lib/auth";
import { requireSuperAdmin } from "@/lib/super-admin";
import { getPlan } from "@/lib/plans";
import { canUseBusinessLine } from "@/lib/billing/capabilities";
import { readAddonActiveFlag } from "@/lib/business-line-view";
import { readEntitlementSource } from "@/lib/business-phone-addon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/business-phone/pending — super-admin list of tenants that have
 * BOUGHT the Business Phone add-on (entitlement active: Pro+ plan AND add-on
 * flag, or a manual pilot) but have NO active number assigned yet — i.e. the
 * ones an operator still needs to finish provisioning.
 *
 * Safe fields only: no Telnyx/Stripe secrets, no API keys.
 */
export async function GET() {
  try {
    await requireSuperAdmin();

    const [settingsRows, activeNumbers] = await Promise.all([
      db
        .select({
          tenantId: tenants.id,
          name: tenants.name,
          slug: tenants.slug,
          currentPlan: tenants.currentPlan,
          subscriptionStatus: tenants.subscriptionStatus,
          isDemo: tenants.isDemo,
          metadata: tenantPhoneSettings.metadata,
          createdAt: tenantPhoneSettings.createdAt,
          updatedAt: tenantPhoneSettings.updatedAt,
        })
        .from(tenantPhoneSettings)
        .innerJoin(tenants, eq(tenants.id, tenantPhoneSettings.tenantId)),
      db
        .select({ tenantId: tenantPhoneNumbers.tenantId })
        .from(tenantPhoneNumbers)
        .where(eq(tenantPhoneNumbers.status, "active")),
    ]);

    const hasActiveNumber = new Set(activeNumbers.map((n) => n.tenantId));

    const pending = settingsRows
      .filter((r) => {
        const planEligible = canUseBusinessLine(getPlan(r.currentPlan)).allowed;
        const addonActive = readAddonActiveFlag(r.metadata);
        return planEligible && addonActive && !hasActiveNumber.has(r.tenantId);
      })
      .map((r) => ({
        tenantId: r.tenantId,
        name: r.name,
        slug: r.slug,
        currentPlan: r.currentPlan,
        subscriptionStatus: r.subscriptionStatus ?? null,
        entitlementSource: readEntitlementSource(r.metadata) ?? "stripe",
        entitled: true,
        numberAssigned: false,
        setupState: "setup_pending" as const,
        isDemo: r.isDemo,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));

    return NextResponse.json({ pending });
  } catch (err) {
    return errorResponse(err);
  }
}
