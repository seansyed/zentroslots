import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  tenants,
  users,
  tenantPhoneSettings,
  tenantPhoneNumbers,
  phoneUsageMonthly,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import BusinessPhoneAdmin from "@/components/admin/BusinessPhoneAdmin";
import { getPlan } from "@/lib/plans";
import { canUseBusinessLine } from "@/lib/billing/capabilities";
import { readAddonActiveFlag } from "@/lib/business-line-view";
import { readEntitlementSource } from "@/lib/business-phone-addon";
import {
  resolveBusinessPhoneSetupState,
  isSuspendedSubscriptionStatus,
} from "@/lib/business-phone-admin";
import { periodForDate } from "@/lib/business-line-view";
import { secondsToBillableMinutes } from "@/lib/business-line";

export const metadata = { title: "Business Phone — Provisioning" };
export const dynamic = "force-dynamic";

/**
 * /admin/business-phone — super-admin manual provisioning console. After a
 * tenant buys the Business Phone add-on, an operator assigns an
 * already-provisioned Telnyx number + forwarding number here. We never buy or
 * call Telnyx; this only records the assignment.
 */
export default async function BusinessPhoneAdminPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const period = periodForDate(new Date());
  const [settingsRows, activeNumbers, usageRows] = await Promise.all([
    db
      .select({
        tenantId: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        currentPlan: tenants.currentPlan,
        subscriptionStatus: tenants.subscriptionStatus,
        isDemo: tenants.isDemo,
        enabled: tenantPhoneSettings.enabled,
        forwardingNumber: tenantPhoneSettings.forwardingNumber,
        monthlyMinuteCap: tenantPhoneSettings.monthlyMinuteCap,
        metadata: tenantPhoneSettings.metadata,
        updatedAt: tenantPhoneSettings.updatedAt,
      })
      .from(tenantPhoneSettings)
      .innerJoin(tenants, eq(tenants.id, tenantPhoneSettings.tenantId)),
    db
      .select({ tenantId: tenantPhoneNumbers.tenantId, phoneNumber: tenantPhoneNumbers.phoneNumber })
      .from(tenantPhoneNumbers)
      .where(eq(tenantPhoneNumbers.status, "active")),
    db
      .select({ tenantId: phoneUsageMonthly.tenantId, billableSeconds: phoneUsageMonthly.billableSeconds })
      .from(phoneUsageMonthly)
      .where(eq(phoneUsageMonthly.period, period)),
  ]);

  const numberByTenant = new Map(activeNumbers.map((n) => [n.tenantId, n.phoneNumber]));
  const usageByTenant = new Map(usageRows.map((u) => [u.tenantId, u.billableSeconds ?? 0]));

  const rows = settingsRows.map((r) => {
    const planEligible = canUseBusinessLine(getPlan(r.currentPlan)).allowed;
    const addonActive = readAddonActiveFlag(r.metadata);
    const manualSource = readEntitlementSource(r.metadata) === "manual";
    const entitledOrManual = (planEligible && addonActive) || manualSource;
    const businessNumber = numberByTenant.get(r.tenantId) ?? null;
    const numberAssigned = Boolean(businessNumber);
    const minutesUsed = secondsToBillableMinutes(usageByTenant.get(r.tenantId) ?? 0);
    const capReached = r.monthlyMinuteCap > 0 && minutesUsed >= r.monthlyMinuteCap;
    const suspended = !entitledOrManual && isSuspendedSubscriptionStatus(r.subscriptionStatus);
    const setupState = resolveBusinessPhoneSetupState({
      entitled: entitledOrManual,
      numberAssigned,
      settingsEnabled: r.enabled,
      suspended,
      capReached,
    });
    return {
      tenantId: r.tenantId,
      name: r.name,
      slug: r.slug,
      currentPlan: r.currentPlan,
      subscriptionStatus: r.subscriptionStatus ?? null,
      entitlementSource: readEntitlementSource(r.metadata) ?? "stripe",
      entitled: entitledOrManual,
      numberAssigned,
      businessNumber,
      forwardingNumber: r.forwardingNumber ?? null,
      enabled: r.enabled,
      minutesUsed,
      monthlyMinuteCap: r.monthlyMinuteCap,
      setupState,
      isDemo: r.isDemo,
    };
  });

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Business Phone"
      crumbs={[{ label: "Super-admin" }, { label: "Business Phone" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-amber-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Business Phone Provisioning</h1>
      <p className="mt-1 text-sm text-slate-600">
        After a tenant buys the Business Phone add-on, assign their
        already-provisioned number here.{" "}
        <strong>Numbers must be provisioned in Telnyx before assigning them here</strong> — this
        console only records the assignment and never buys or configures Telnyx.
      </p>
      <div className="mt-5">
        <BusinessPhoneAdmin rows={rows} />
      </div>
    </Shell>
  );
}
