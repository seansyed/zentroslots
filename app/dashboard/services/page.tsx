import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import ServicesClient from "@/components/dashboard/ServicesClient";

export default async function ServicesPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  // Staff catalog (for the assignment editor inside the service drawer).
  const staffRows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.tenantId, user.tenantId), eq(users.role, "staff")))
    .orderBy(asc(users.name));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Services"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Services" }]}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-heading font-semibold text-ink">Services</h1>
          <p className="mt-1 text-sm text-ink-muted">What you offer. Durations, pricing, color, and staff assignments.</p>
        </div>
      </div>

      <ServicesClient
        isAdmin={user.role === "admin" || user.role === "manager"}
        allStaff={staffRows}
      />
    </Shell>
  );
}
