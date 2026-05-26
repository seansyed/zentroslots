import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import DiagnosticsClient from "@/components/admin/DiagnosticsClient";
import { computeDiagnostics } from "@/lib/admin-analytics/diagnostics";

export const metadata = { title: "Admin Diagnostics" };
export const dynamic = "force-dynamic";

/**
 * /admin/diagnostics — Internal admin-analytics health view.
 *
 * Surfaces schema drift, failing KPI aggregations, stale snapshots,
 * and cache stats. This is the canonical "is the analytics layer
 * healthy?" page. Read-only.
 */
export default async function DiagnosticsPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  const initial = await computeDiagnostics().catch(() => null);

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Admin Diagnostics"
      crumbs={[{ label: "Super-admin" }, { label: "Diagnostics" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Admin Diagnostics</h1>
      <p className="mt-1 text-sm text-slate-600">
        Schema drift detection, KPI aggregation smoke tests, snapshot freshness, and cache stats.
        If a KPI shows &quot;Unable to compute&quot; on the dashboard, the categorical reason
        appears here.
      </p>
      <div className="mt-5">
        <DiagnosticsClient initial={initial} />
      </div>
    </Shell>
  );
}
