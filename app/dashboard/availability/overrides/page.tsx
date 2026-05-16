import { redirect } from "next/navigation";
import { and, eq, gte } from "drizzle-orm";

import { db } from "@/db/client";
import { availabilityOverrides, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import OverridesManager from "@/components/OverridesManager";
import Shell from "@/components/dashboard/Shell";

export default async function OverridesPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      id: availabilityOverrides.id,
      date: availabilityOverrides.date,
      unavailable: availabilityOverrides.unavailable,
      startTime: availabilityOverrides.startTime,
      endTime: availabilityOverrides.endTime,
      reason: availabilityOverrides.reason,
    })
    .from(availabilityOverrides)
    .where(
      and(
        eq(availabilityOverrides.tenantId, user.tenantId),
        eq(availabilityOverrides.userId, user.id),
        gte(availabilityOverrides.date, today)
      )
    );

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Overrides"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Working hours", href: "/dashboard/availability" }, { label: "Overrides" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Vacations &amp; overrides</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Block dates, add lunch breaks, or set custom hours for a specific day. Overrides take
        precedence over your weekly schedule.
      </p>

      <OverridesManager
        initial={rows.map((r) => ({
          id: r.id,
          date: r.date,
          unavailable: r.unavailable,
          startTime: r.startTime ?? null,
          endTime: r.endTime ?? null,
          reason: r.reason ?? null,
        }))}
        userTimezone={user.timezone}
      />
    </Shell>
  );
}
