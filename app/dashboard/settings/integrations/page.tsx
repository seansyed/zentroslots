import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import { getPlan } from "@/lib/plans";
import IntegrationsClient from "@/components/dashboard/IntegrationsClient";

export default async function IntegrationsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const plan = getPlan(tenant.currentPlan);
  const canHideBadge = plan.limits.customBranding;

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Integrations"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Settings" }, { label: "Integrations" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Integrations</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Wire your workspace to your inbox, calendar, and chat tools.
      </p>

      <IntegrationsClient
        initial={{
          googleConnected: Boolean(user.googleRefreshToken),
          notificationWebhookUrl: tenant.notificationWebhookUrl ?? "",
          hidePoweredBy: tenant.hidePoweredBy,
        }}
        plan={{ id: plan.id, name: plan.name, canHideBadge }}
      />
    </Shell>
  );
}
