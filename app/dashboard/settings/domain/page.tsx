import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantDomains, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import Shell from "@/components/dashboard/Shell";
import DomainsClient from "@/components/dashboard/DomainsClient";

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
    .where(eq(tenantDomains.tenantId, tenant.id));

  return (
    <Shell
      user={{ name: user.name, email: user.email, role: user.role }}
      tenant={{ name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl }}
      title="Custom domain"
      crumbs={[{ label: "Dashboard", href: "/dashboard" }, { label: "Settings" }, { label: "Domain" }]}
    >
      <h1 className="text-heading font-semibold text-ink">Custom domain</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Serve your booking page from your own hostname (e.g. <code className="rounded bg-surface-inset px-1.5 py-0.5 font-mono text-xs">book.acme.com</code>).
        Verification only — DNS routing is configured by your administrator.
      </p>

      <DomainsClient
        initial={rows.map((r) => ({
          id: r.id,
          host: r.host,
          verificationToken: r.verificationToken,
          verifiedAt: r.verifiedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
    </Shell>
  );
}
