import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { CNAME_TARGET, TXT_PREFIX } from "@/lib/domains";
import { getPlan } from "@/lib/plans";
import Shell from "@/components/dashboard/Shell";
import DomainsClient from "@/components/dashboard/DomainsClient";

export const dynamic = "force-dynamic";

export default async function DomainSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const rows = await db
    .select()
    .from(tenantDomains)
    .where(eq(tenantDomains.tenantId, tenant.id))
    .orderBy(tenantDomains.createdAt);

  const plan = getPlan(tenant.currentPlan);

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Custom Domains"
      crumbs={[
        { label: "Dashboard", href: "/dashboard" },
        { label: "Settings" },
        { label: "Custom Domains" },
      ]}
    >
      {/* The Command Center hero lives inside the client so the KPI
          tiles can react instantly to verify / add / delete actions. */}
      <DomainsClient
        initial={rows.map((r) => ({
          id: r.id,
          host: r.host,
          normalizedHost: r.normalizedHost,
          verificationToken: r.verificationToken,
          status: r.status as "pending" | "verified" | "failed",
          sslStatus: r.sslStatus as "pending" | "active" | "failed",
          verifiedAt: r.verifiedAt?.toISOString() ?? null,
          lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        }))}
        config={{ cnameTarget: CNAME_TARGET, txtPrefix: TXT_PREFIX }}
        tenantSlug={tenant.slug}
        plan={{
          id: plan.id,
          name: plan.name,
          maxCustomDomains: plan.limits.maxCustomDomains,
        }}
      />
    </Shell>
  );
}
