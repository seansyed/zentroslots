import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import RoutingClient from "@/components/dashboard/RoutingClient";

export const metadata = { title: "Staff routing" };
export const dynamic = "force-dynamic";

export default async function StaffRoutingPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || (user.role !== "admin" && user.role !== "manager")) redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Staff routing"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Staff routing" },
      ]}
    >
      <h1 className="text-heading font-semibold text-ink">Staff routing</h1>
      <p className="mt-1 max-w-2xl text-sm text-ink-muted">
        Pick how the system assigns staff when a customer doesn&apos;t
        choose one. Defaults to <code>manual</code> — the customer
        always picks. Configure a tenant default for the whole
        workspace, or override per service. No rule means
        byte-identical behavior to before this feature shipped.
      </p>

      <RoutingClient />
    </Shell>
  );
}
