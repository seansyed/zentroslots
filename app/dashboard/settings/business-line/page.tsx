/**
 * Settings → Business Line (server entry). Admin-only.
 *
 * The page itself only resolves the signed-in admin + tenant (no Business Line
 * tables touched here, so it renders even before migration 0077 is applied).
 * All Business Line data is loaded client-side from /api/tenant/business-line,
 * which degrades gracefully if the feature isn't available yet.
 *
 * This is the SETTINGS surface only — no number provisioning, no Telnyx calls,
 * no call forwarding.
 */

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import BusinessLineClient from "@/components/dashboard/BusinessLineClient";

export const dynamic = "force-dynamic";

export default async function BusinessLinePage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.currentPlan,
        logoUrl: tenant.logoUrl,
      }}
      title="Business Phone settings"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Business Phone" },
      ]}
    >
      <BusinessLineClient />
    </Shell>
  );
}
