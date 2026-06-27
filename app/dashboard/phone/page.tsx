/**
 * Dashboard → Phone (server entry). The first real Business Phone app surface.
 *
 * Visible ONLY to subscribed Business Phone tenants: this server guard resolves
 * the signed-in operator + tenant and redirects away when the workspace is not
 * entitled (Pro+ plan AND active add-on) — so an unentitled tenant can never
 * reach the page even by URL. The client APIs additionally return 402 on direct
 * hits. Restricted to operator roles (admin/manager) that can place calls + read
 * the call log; the sidebar item is gated to match.
 *
 * No Telnyx contact here — all data + actions go through the entitlement-gated
 * /api/tenant/phone/* routes client-side.
 */

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isBusinessPhoneEntitled } from "@/lib/business-phone-access";
import Shell from "@/components/dashboard/Shell";
import PhoneClient from "@/components/dashboard/PhoneClient";

export const dynamic = "force-dynamic";

export default async function PhonePage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  // Operator roles only (they can place calls + read the log).
  if (user.role !== "admin" && user.role !== "manager") redirect("/dashboard");

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Hard gate: hidden completely for unentitled tenants (no exception).
  const entitled = await isBusinessPhoneEntitled(tenant.id, tenant.currentPlan);
  if (!entitled) redirect("/dashboard");

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Phone"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Phone" }]}
    >
      <PhoneClient />
    </Shell>
  );
}
