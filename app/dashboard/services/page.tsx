import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { departments, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import ServicesClient from "@/components/dashboard/ServicesClient";

export default async function ServicesPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  // Staff catalog (for the assignment editor inside the service drawer
  // AND the dedicated Assign Staff panel). Enriched with department
  // info so the panel can offer department-aware filtering. Same
  // role gating as before (staff only — managers are not assignable
  // to services here).
  const staffRows = await db
    .select({
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      departmentId: users.departmentId,
      departmentName: departments.name,
    })
    .from(users)
    .leftJoin(departments, eq(departments.id, users.departmentId))
    .where(and(eq(users.tenantId, user.tenantId), eq(users.role, "staff")))
    .orderBy(asc(users.name));

  // Department catalog (for in-drawer scaffolding + the empty-state
  // activation checklist that links to /dashboard/departments).
  const departmentRows = await db
    .select({ id: departments.id, name: departments.name, color: departments.color })
    .from(departments)
    .where(eq(departments.tenantId, user.tenantId))
    .orderBy(asc(departments.name));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Services"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Services" }]}
    >
      <ServicesClient
        isAdmin={user.role === "admin" || user.role === "manager"}
        allStaff={staffRows.map((s) => ({
          id: s.id,
          name: s.name,
          avatarUrl: s.avatarUrl ?? null,
          departmentId: s.departmentId ?? null,
          departmentName: s.departmentName ?? null,
        }))}
        allDepartments={departmentRows.map((d) => ({ id: d.id, name: d.name, color: d.color ?? null }))}
      />
    </Shell>
  );
}
