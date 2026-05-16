import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { departments, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import DepartmentsManager from "@/components/dashboard/DepartmentsManager";

export default async function DepartmentsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const rows = await db
    .select()
    .from(departments)
    .where(eq(departments.tenantId, user.tenantId))
    .orderBy(asc(departments.name));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Departments"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Departments" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Departments</h1>
      <p className="mt-1 text-sm text-ink-muted">Group services and staff by business unit — Sales, Consultation, Hair Styling, etc.</p>

      <DepartmentsManager
        isAdmin={user.role === "admin"}
        initial={rows.map((r) => ({
          id: r.id,
          name: r.name,
          color: r.color ?? null,
          description: r.description ?? null,
        }))}
      />
    </Shell>
  );
}
