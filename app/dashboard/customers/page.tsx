import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import CustomersClient from "@/components/dashboard/CustomersClient";

export default async function CustomersPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Customers"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Customers" }]}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-heading font-semibold text-ink">Customers</h1>
          <p className="mt-1 text-sm text-ink-muted">Everyone who's booked with you, with full history.</p>
        </div>
      </div>
      <CustomersClient userTimezone={user.timezone} canManage={user.role === "admin" || user.role === "staff" || user.role === "manager"} />
    </Shell>
  );
}
