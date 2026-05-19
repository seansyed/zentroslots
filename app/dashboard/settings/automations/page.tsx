import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import AutomationsClient from "@/components/dashboard/AutomationsClient";
import { effectivePermissions, userHasPermission } from "@/lib/security/permissions";

export const metadata = { title: "Follow-up automations" };
export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  // Additive: admin/manager pass via existing role check; staff who
  // have been granted canManageAutomation via per-user override also
  // pass now. Existing admin/manager behavior preserved.
  if (user.role !== "admin" && user.role !== "manager" && !userHasPermission(user, "canManageAutomation")) {
    redirect("/dashboard");
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const permissions = effectivePermissions(user);
  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role, permissions }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Follow-up automations"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Follow-up automations" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Follow-up automations</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Review requests and post-appointment follow-ups. Rules fire
        after a booking flips to <code>completed</code> or
        <code>no_show</code>. Without a rule, nothing extra is sent —
        same behavior as before this feature shipped.
      </p>

      <AutomationsClient />
    </Shell>
  );
}
