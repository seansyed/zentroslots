import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import { computeRevenueSeries } from "@/lib/admin-analytics/revenue";
import RevenueCharts from "@/components/admin/RevenueCharts";

export const metadata = { title: "Revenue analytics" };
export const dynamic = "force-dynamic";

/**
 * /admin/revenue — SA-2 revenue visualizations.
 *
 * Seven charts driven by cross-tenant aggregations from
 * billing_transactions, tenants, plans, audit_logs, and bookings.
 * No mock data: every series is built from real DB queries.
 *
 * Resilience: computeRevenueSeries() catches per-section errors
 * internally and surfaces them inside the bundle as `errors[key]`
 * — the page always renders; failed charts show an inline error
 * card. If the orchestrator itself throws (extreme case), we
 * fall through to a single-panel amber notice and the rest of
 * the super-admin navigation remains usable.
 */
export default async function RevenueAnalyticsPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  let series: Awaited<ReturnType<typeof computeRevenueSeries>> | null = null;
  try {
    series = await computeRevenueSeries();
  } catch (err) {
    try {
      console.error(
        JSON.stringify({
          evt: "admin_revenue_fatal",
          err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        }),
      );
    } catch {}
  }

  return (
    <Shell
      user={
        me
          ? { name: me.name, email: me.email, role: me.role }
          : { name: session.email, email: session.email, role: "admin" }
      }
      variant="super"
      title="Revenue analytics"
      crumbs={[{ label: "Super-admin" }, { label: "Revenue" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">
        Internal — superuser only
      </div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Revenue analytics</h1>
      <p className="mt-1 text-sm text-slate-600">
        Cross-tenant revenue, signup, plan, and churn trends. Read-only — all values are
        computed directly from production data on each page load (cached 3 minutes).
      </p>

      {series ? (
        <div className="mt-6">
          <div className="mb-3 text-[11px] text-slate-400">
            computed in {series.computedInMs}ms · cached 3min
          </div>
          <RevenueCharts data={series} />
        </div>
      ) : (
        <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50/40 p-6 text-sm text-amber-800">
          Revenue series failed to compute. The orchestrator itself threw — check pm2 logs
          for{" "}
          <code className="rounded bg-amber-100 px-1 text-[12px]">admin_revenue_fatal</code>
          .
        </section>
      )}
    </Shell>
  );
}
