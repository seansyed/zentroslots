/**
 * Dashboard → Phone (server entry). The first real Business Phone app surface.
 *
 * Visible ONLY to subscribed Business Phone tenants AND users with phone access:
 * this server guard resolves the signed-in user + tenant and redirects away
 * unless `hasPhoneAccess` (entitled tenant + operator role, or a staff member an
 * admin has granted Business Phone access). So an unentitled tenant — or a staff
 * member without access — can never reach the page even by URL. The client APIs
 * additionally return 402/403 on direct hits.
 *
 * The broader call log is operator-only (admin/manager); staff see their own
 * dialer + number setup but not the workspace call log.
 *
 * No Telnyx contact here — all data + actions go through the entitlement-gated
 * /api/tenant/phone/* routes client-side.
 */

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { getUserBusinessPhoneVisibility } from "@/lib/business-phone-access";
import { getBusinessPhoneStatus } from "@/lib/business-phone-status";
import Shell from "@/components/dashboard/Shell";
import PhoneClient from "@/components/dashboard/PhoneClient";

export const dynamic = "force-dynamic";

export default async function PhonePage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Gate: operators (admin/manager) always reach the page — they see the
  // marketing/upgrade card when Business Phone isn't active yet, and the live
  // controls once it is. Staff reach it only with admin-granted phone access.
  // Everyone else (e.g. client role) is redirected away.
  const vis = await getUserBusinessPhoneVisibility(tenant.id, user.id, user.role, tenant.currentPlan);
  const isOperator = user.role === "admin" || user.role === "manager";
  if (!vis.hasPhoneAccess && !isOperator) redirect("/dashboard");

  // Phase 4 — setup state (setup_pending / disabled / cap_reached / active) so
  // the client shows the right banner and never fake controls.
  const status = await getBusinessPhoneStatus({
    id: tenant.id,
    currentPlan: tenant.currentPlan,
    subscriptionStatus: tenant.subscriptionStatus,
    stripeSubscriptionId: tenant.stripeSubscriptionId,
  });

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Business Phone"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Business Phone" }]}
    >
      {/* viewerRole drives operator-only sections (call log + staff access).
          The full status drives the hero, marketing/upgrade card, and the
          Phase 4 state banners. */}
      <PhoneClient viewerRole={user.role} status={status} />
    </Shell>
  );
}
