import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import { computeRevenueSeries } from "@/lib/admin-analytics/revenue";
import {
  computeRevenueExecutiveKpis,
  deriveRevenueInsights,
} from "@/lib/admin-analytics/revenue-intelligence";
import RevenueCharts from "@/components/admin/RevenueCharts";
import RevenueExecutiveHero from "@/components/admin/RevenueExecutiveHero";

export const metadata = { title: "Revenue analytics" };
export const dynamic = "force-dynamic";

/**
 * /admin/revenue — Executive Analytics Center.
 *
 * Two parallel data fetches:
 *   • computeRevenueSeries() — the 7 chart series (cross-tenant)
 *   • computeRevenueExecutiveKpis() — hero strip (MRR, ARR, growth,
 *     active subs, NRR proxy, trial conversion)
 *
 * Insights are derived deterministically from the same series + KPIs.
 * NO LLM. NO fake metrics. When a number is uncomputable (low volume,
 * no prior period, no recent trials), the UI renders "—".
 */
export default async function RevenueAnalyticsPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  const [series, kpis] = await Promise.all([
    computeRevenueSeries().catch(() => null),
    computeRevenueExecutiveKpis().catch(() => null),
  ]);

  const insights = series && kpis ? deriveRevenueInsights(series, kpis) : [];

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
        Cross-tenant revenue intelligence. Every metric is computed from real production data;
        deterministic insights surface only when threshold conditions are met.
      </p>

      {/* Executive hero — animated MRR / ARR / NRR / trial conv. + insight chips */}
      {series && kpis ? (
        <div className="mt-6">
          <RevenueExecutiveHero series={series} kpis={kpis} insights={insights} />
        </div>
      ) : null}

      {/* Detailed charts with chart-adjacent insight chips */}
      {series ? (
        <div className="mt-8">
          <div className="mb-3 text-[11px] text-slate-400">
            computed in {series.computedInMs}ms · cached 3min
          </div>
          <RevenueCharts data={series} insights={insights} />
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
