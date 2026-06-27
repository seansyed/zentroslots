// Server-side Business Phone status gather (Phase 4). Loads the entitlement +
// usage rows a tenant's billing card and Phone page need, then delegates to the
// PURE shapeBusinessPhoneStatus() for the safe DTO. SERVER ONLY (imports db).

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantPhoneSettings, phoneUsageMonthly } from "@/db/schema";
import { getTenantBusinessPhone } from "@/lib/business-phone-access";
import { businessPhoneAddonPriceId } from "@/lib/stripe";
import {
  readEntitlementSource,
  readAddonSubscribedFlag,
  isModifiableSubscriptionStatus,
} from "@/lib/business-phone-addon";
import {
  shapeBusinessPhoneStatus,
  type BusinessPhoneClientStatus,
} from "@/lib/business-phone-admin";
import { periodForDate } from "@/lib/business-line-view";
import { secondsToBillableMinutes } from "@/lib/business-line";

/**
 * Resolve the safe Business Phone status for a tenant (billing card + Phone
 * page). Returns NO Stripe/Telnyx ids or secrets — the number is masked.
 */
export async function getBusinessPhoneStatus(tenant: {
  id: string;
  currentPlan: string | null;
  subscriptionStatus: string | null;
  stripeSubscriptionId: string | null;
}): Promise<BusinessPhoneClientStatus> {
  const period = periodForDate(new Date());
  const [bp, settings, usage] = await Promise.all([
    getTenantBusinessPhone(tenant.id),
    db.query.tenantPhoneSettings.findFirst({
      where: eq(tenantPhoneSettings.tenantId, tenant.id),
      columns: { metadata: true },
    }),
    db.query.phoneUsageMonthly.findFirst({
      where: and(eq(phoneUsageMonthly.tenantId, tenant.id), eq(phoneUsageMonthly.period, period)),
      columns: { billableSeconds: true },
    }),
  ]);

  const manualSource = readEntitlementSource(settings?.metadata) === "manual";
  const addonSubscribed = readAddonSubscribedFlag(settings?.metadata) || manualSource;

  return shapeBusinessPhoneStatus({
    planEligible: bp.planEligible,
    addonActive: bp.addonActive,
    manualSource,
    addonSubscribed,
    businessNumber: bp.businessNumber,
    settingsEnabled: bp.settingsEnabled,
    monthlyMinuteCap: bp.monthlyMinuteCap,
    minutesUsed: secondsToBillableMinutes(usage?.billableSeconds ?? 0),
    subscriptionStatus: tenant.subscriptionStatus,
    baseSubscriptionActive:
      Boolean(tenant.stripeSubscriptionId) && isModifiableSubscriptionStatus(tenant.subscriptionStatus),
    addonConfigured: businessPhoneAddonPriceId() != null,
  });
}
