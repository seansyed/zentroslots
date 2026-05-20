import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import { getPlan } from "@/lib/plans";
import IntegrationsClient from "@/components/dashboard/IntegrationsClient";

// Page repositioned to "Workspace Integrations" (migration 0035
// phase). This page enables PROVIDERS at the workspace level — it
// no longer surfaces personal calendar OAuth state. Per-staff
// calendar connections live in the staff Profile tab and at
// /dashboard/settings/calendar.
export const dynamic = "force-dynamic";

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
      title="Workspace integrations"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Settings" }, { label: "Workspace integrations" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Workspace integrations</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Enable or disable provider integrations across your workspace.
      </p>

      <IntegrationsClient
        initial={{
          notificationWebhookUrl: tenant.notificationWebhookUrl ?? "",
          hidePoweredBy: tenant.hidePoweredBy,
        }}
        plan={{ id: plan.id, name: plan.name, canHideBadge }}
      />
    </Shell>
  );
}
