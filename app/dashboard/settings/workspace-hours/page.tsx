import { redirect } from "next/navigation";
import { eq, inArray, and } from "drizzle-orm";

import { db } from "@/db/client";
import { availability, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import WorkspaceHoursClient from "@/components/dashboard/WorkspaceHoursClient";
import { readDefaultWorkspaceHours } from "@/lib/workspace-hours";

// Tenant-level default workspace hours (migration 0034).
// Admin / manager only — the toggle gating + 403 on PUT live in
// /api/tenant/workspace-hours. Page itself shows a calm read-only
// view for non-admins so anyone can see what's configured.

export const dynamic = "force-dynamic";

export default async function WorkspaceHoursPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard/login");

  const initialHours = readDefaultWorkspaceHours(tenant.defaultWorkspaceHours);

  // Operational intelligence: how many workforce members are
  // currently INHERITING workspace hours (i.e. have zero rows in
  // `availability`)? Surfaces the user's refinement #4.
  const workforce = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.tenantId, user.tenantId), inArray(users.role, ["admin", "manager", "staff"])));
  const workforceIds = workforce.map((u) => u.id);

  let inheritingCount = 0;
  let workforceCount = workforceIds.length;
  if (workforceIds.length > 0) {
    const withRules = await db
      .selectDistinct({ userId: availability.userId })
      .from(availability)
      .where(and(eq(availability.tenantId, user.tenantId), inArray(availability.userId, workforceIds)));
    const withRulesSet = new Set(withRules.map((r) => r.userId));
    inheritingCount = workforceIds.filter((id) => !withRulesSet.has(id)).length;
  }

  const isAdmin = user.role === "admin" || user.role === "manager";

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Workspace hours"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Workspace hours" },
      ]}
    >
      <WorkspaceHoursClient
        initial={initialHours}
        canEdit={isAdmin}
        initialInheritingCount={inheritingCount}
        workforceCount={workforceCount}
      />
    </Shell>
  );
}
