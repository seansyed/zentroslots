import { redirect } from "next/navigation";
import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import EmbedSnippetsClient from "@/components/dashboard/EmbedSnippetsClient";

const APP_BASE_URL = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

export default async function EmbedSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  // Per-service staff count powers a "not bookable" warning in the
  // snippet UI. Embed page hard-blocks rendering when staffCount=0, so
  // copying a snippet for an empty service would result in a broken
  // embed on the customer's site — warn before the copy, not after.
  const serviceList = await db
    .select({
      id: services.id,
      name: services.name,
      slug: services.slug,
      staffCount: sql<number>`(SELECT COUNT(*)::int FROM service_staff WHERE service_staff.service_id = ${services.id})`,
    })
    .from(services)
    .where(and(eq(services.tenantId, tenant.id), eq(services.isActive, 1)))
    .orderBy(asc(services.name));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Embed widgets"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Settings" }, { label: "Embed" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Embed your booking widget</h1>
      <p className="mt-1 text-sm text-ink-muted">Drop one of these snippets into any website to take bookings inline.</p>

      <EmbedSnippetsClient
        baseUrl={APP_BASE_URL}
        tenantSlug={tenant.slug}
        services={serviceList.map((s) => ({ id: s.id, name: s.name, slug: s.slug, hasStaff: Number(s.staffCount) > 0 }))}
      />
    </Shell>
  );
}
