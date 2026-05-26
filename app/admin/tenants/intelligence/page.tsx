import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import TenantIntelligenceClient from "@/components/admin/TenantIntelligenceClient";
import { fetchTenantIntelligence } from "@/lib/admin-analytics/tenant-intelligence";

export const metadata = { title: "Tenant Intelligence" };
export const dynamic = "force-dynamic";

/**
 * /admin/tenants/intelligence — SA-4.
 *
 * Server-renders the first page (25 rows, default sort by MRR desc)
 * for fast first paint; client component takes over with filters,
 * pagination, drawer, and bulk actions.
 *
 * Per-section fatal isolation: if the initial fetch throws, pass
 * null so the client can render an explicit error.
 */
export default async function TenantIntelligencePage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const initial = await fetchTenantIntelligence({ page: 1, pageSize: 25, sort: "mrr", order: "desc" }).catch(
    () => null,
  );

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Tenant Intelligence"
      crumbs={[{ label: "Super-admin" }, { label: "Tenants" }, { label: "Intelligence" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Tenant Intelligence</h1>
      <p className="mt-1 text-sm text-slate-600">
        Operational view across every tenant: MRR, growth, health score, risk level, integrations,
        and one-click admin actions. All values from real DB queries (cached 60s).
      </p>

      <div className="mt-5">
        <TenantIntelligenceClient initial={initial} />
      </div>
    </Shell>
  );
}
