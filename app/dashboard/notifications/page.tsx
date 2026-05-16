import { redirect } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { notifications, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import NotificationsClient from "@/components/dashboard/NotificationsClient";

export default async function NotificationsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.tenantId, user.tenantId), eq(notifications.userId, user.id)))
    .orderBy(desc(notifications.createdAt))
    .limit(100);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Notifications"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Notifications" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Notifications</h1>
      <p className="mt-1 text-sm text-ink-muted">Everything that needs your attention.</p>

      <NotificationsClient
        initial={rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          title: r.title,
          body: r.body,
          link: r.link,
          readAt: r.readAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
    </Shell>
  );
}
