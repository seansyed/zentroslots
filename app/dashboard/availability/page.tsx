import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { availability, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import AvailabilityEditor from "@/components/AvailabilityEditor";
import Shell from "@/components/dashboard/Shell";

export default async function AvailabilityPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");

  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const rules = await db
    .select()
    .from(availability)
    .where(eq(availability.userId, user.id));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Weekly availability"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Working hours" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Weekly availability</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Times are in your timezone ({user.timezone}).
      </p>

      <AvailabilityEditor
        initial={rules.map((r) => ({
          dayOfWeek: r.dayOfWeek,
          startTime: r.startTime.slice(0, 5),
          endTime: r.endTime.slice(0, 5),
        }))}
      />
    </Shell>
  );
}
