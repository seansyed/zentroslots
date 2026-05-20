import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import StaffClient from "@/components/dashboard/StaffClient";

export default async function StaffPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  // Service catalog for the assignment editor — small + cheap to ship server-side.
  const serviceRows = await db
    .select({ id: services.id, name: services.name, durationMinutes: services.durationMinutes, color: services.color })
    .from(services)
    .where(and(eq(services.tenantId, user.tenantId), eq(services.isActive, 1)))
    .orderBy(asc(services.name));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Staff"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Staff" }]}
    >
      <StaffClient
        userTimezone={user.timezone}
        isAdmin={user.role === "admin" || user.role === "manager"}
        canChangeRoles={user.role === "admin"}
        allServices={serviceRows.map((r) => ({ id: r.id, name: r.name, durationMinutes: r.durationMinutes, color: r.color ?? null }))}
      />
    </Shell>
  );
}
