import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { locations, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import LocationsManager from "@/components/dashboard/LocationsManager";

export default async function LocationsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });

  const rows = await db
    .select()
    .from(locations)
    .where(eq(locations.tenantId, user.tenantId))
    .orderBy(asc(locations.name));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={tenant ? { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl } : undefined}
      title="Locations"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Locations" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Locations</h1>
      <p className="mt-1 text-sm text-ink-muted">Physical or virtual places where services are delivered.</p>

      <LocationsManager
        isAdmin={user.role === "admin" || user.role === "manager"}
        defaultTimezone={user.timezone}
        initial={rows.map((r) => ({
          id: r.id,
          name: r.name,
          address: r.address ?? null,
          timezone: r.timezone ?? null,
          phone: r.phone ?? null,
          email: r.email ?? null,
          isActive: r.isActive,
        }))}
      />
    </Shell>
  );
}
