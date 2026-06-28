import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants } from "@/db/schema";
import { errorResponse, HttpError, requireUser } from "@/lib/auth";
import { getTenantBusinessPhone, getUserBusinessPhoneVisibility } from "@/lib/business-phone-access";
import { getBusinessPhoneStatus } from "@/lib/business-phone-status";
import { shapeMobilePhoneStatus } from "@/lib/business-phone-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tenant/phone/status — mobile-ready Business Phone status for the
 * signed-in user. Returns ONLY display-safe fields (no Stripe/Telnyx ids, no
 * keys/secrets, no internal metadata). The mobile app uses this to decide which
 * Phone screen state to render (marketing / setup-pending / active / locked /
 * cap-reached) and whether to offer click-to-call.
 *
 * Mobile cannot purchase or activate the add-on — the only CTA is opening the
 * web billing page (webBillingUrl). softphoneAvailable is flag-driven and
 * defaults to false until the Phase-2 softphone exists.
 */
export async function GET() {
  try {
    const user = await requireUser();

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId),
      columns: { id: true, currentPlan: true, subscriptionStatus: true, stripeSubscriptionId: true },
    });
    if (!tenant) throw new HttpError(404, "Tenant not found.");

    const [status, bp, vis] = await Promise.all([
      getBusinessPhoneStatus({
        id: tenant.id,
        currentPlan: tenant.currentPlan,
        subscriptionStatus: tenant.subscriptionStatus,
        stripeSubscriptionId: tenant.stripeSubscriptionId,
      }),
      getTenantBusinessPhone(tenant.id),
      getUserBusinessPhoneVisibility(tenant.id, user.id, user.role, tenant.currentPlan),
    ]);

    const webBillingUrl =
      `${(process.env.APP_BASE_URL ?? "https://app.zentromeet.com").replace(/\/+$/, "")}/dashboard/billing`;
    // Softphone stays dark until the Phase-2 build exists. Flag-driven so we can
    // light it up per-environment without code changes.
    const softphoneAvailable = process.env.BUSINESS_PHONE_SOFTPHONE_AVAILABLE === "true";

    const dto = shapeMobilePhoneStatus({
      basePlan: tenant.currentPlan,
      paidPlan: (tenant.currentPlan ?? "free") !== "free",
      status,
      businessNumber: bp.businessNumber,
      forwardingNumber: bp.forwardingNumber,
      hasPhoneAccess: vis.hasPhoneAccess,
      canPlaceCalls: vis.canPlaceCalls,
      softphoneAvailable,
      webBillingUrl,
    });

    return NextResponse.json(dto);
  } catch (err) {
    return errorResponse(err);
  }
}
