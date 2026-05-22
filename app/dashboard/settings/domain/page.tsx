import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { CNAME_TARGET, TXT_PREFIX } from "@/lib/domains";
import { loadCapabilitiesForTenant } from "@/lib/billing/loadCapabilities";
import Shell from "@/components/dashboard/Shell";
import DomainsClient from "@/components/dashboard/DomainsClient";
import { CapabilityProvider } from "@/components/billing/CapabilityProvider";

export const dynamic = "force-dynamic";

export default async function DomainSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user || user.role !== "admin") redirect("/dashboard");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const [rows, capabilities] = await Promise.all([
    db
      .select()
      .from(tenantDomains)
      .where(eq(tenantDomains.tenantId, tenant.id))
      .orderBy(tenantDomains.createdAt),
    // Phase 3 capability hydration. Server-fetched payload is handed
    // to <CapabilityProvider initial=...> so the client tree reads
    // plan + capability state synchronously on first render — no
    // unlock flicker, no client-side fetch on mount.
    loadCapabilitiesForTenant(tenant.id),
  ]);

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
      <CapabilityProvider initial={capabilities}>
        {/* The Command Center hero lives inside the client so the KPI
            tiles can react instantly to verify / add / delete actions.
            Plan + custom_domains capability come from the provider
            above — no more duplicated `plan` prop. */}
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
        />
      </CapabilityProvider>
    </Shell>
  );
}
