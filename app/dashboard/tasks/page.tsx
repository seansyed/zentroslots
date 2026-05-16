import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { customers, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import TasksClient from "@/components/dashboard/TasksClient";

export default async function TasksPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const [staffRows, customerRows] = await Promise.all([
    db.select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.tenantId, user.tenantId)))
      .orderBy(asc(users.name)),
    db.select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(eq(customers.tenantId, user.tenantId))
      .orderBy(asc(customers.name)),
  ]);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Tasks"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Tasks" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Tasks</h1>
      <p className="mt-1 text-sm text-ink-muted">Operational follow-ups, calls, and reminders for your team.</p>

      <TasksClient allStaff={staffRows} allCustomers={customerRows} myUserId={user.id} />
    </Shell>
  );
}
