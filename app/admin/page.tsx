import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { auditLogs, bookings, plans, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { isSuperAdminEmail } from "@/lib/super-admin";
import Shell from "@/components/dashboard/Shell";
import { Badge } from "@/components/ui/primitives";
// SA-1 — Executive KPI layer (16 cross-tenant metrics).
import { computeAllKpis } from "@/lib/admin-analytics/kpis";
import OverviewExperience from "@/components/admin/OverviewExperience";

export const metadata = { title: "Internal admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    // 404 to avoid revealing the existence of the admin route.
    redirect("/not-found-this-is-ok");
  }
  const me = await db.query.users.findFirst({ where: eq(users.id, session.sub) });

  // SA-1 — Executive KPI bundle. Computed independently of the legacy
  // section queries below so a failure here can't crash the page. If
  // computeAllKpis itself throws (extreme — every metric is wrapped),
  // we still render the rest of the dashboard.
  let kpiBundle: Awaited<ReturnType<typeof computeAllKpis>> | null = null;
  try {
    kpiBundle = await computeAllKpis();
  } catch (err) {
    kpiBundle = null;
    try {
      console.error(
        JSON.stringify({ evt: "admin_kpis_fatal", err: err instanceof Error ? err.message.slice(0, 200) : "unknown" }),
      );
    } catch {}
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    allTenants,
    [usersTotal],
    [bookingsTotal],
    recentAudit,
    [emailFailures],
    [emailSent],
    expiredGoogleTenants,
    [recentBookings],
    planRows,
    tenantPlanDistribution,
    [tenantsNew30d],
    [newTrialsLast30d],
    [convertedLast30d],
  ] = await Promise.all([
    db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        plan: tenants.currentPlan,
        status: tenants.subscriptionStatus,
        stripeCustomerId: tenants.stripeCustomerId,
        createdAt: tenants.createdAt,
      })
      .from(tenants)
      .orderBy(desc(tenants.createdAt))
      .limit(50),
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(bookings),
    db
      .select({
        id: auditLogs.id,
        tenantId: auditLogs.tenantId,
        action: auditLogs.action,
        actorLabel: auditLogs.actorLabel,
        entityType: auditLogs.entityType,
        ip: auditLogs.ipAddress,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(50),
    db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "email.failed"), gte(auditLogs.createdAt, sevenDaysAgo))),
    db
      .select({ n: count() })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "email.sent"), gte(auditLogs.createdAt, sevenDaysAgo))),
    db
      .select({
        id: tenants.id,
        name: tenants.name,
        slug: tenants.slug,
        users: sql<number>`(SELECT COUNT(*)::int FROM users WHERE users.tenant_id = ${tenants.id} AND users.google_status IN ('expired', 'error'))`,
      })
      .from(tenants)
      .where(
        sql`EXISTS (SELECT 1 FROM users WHERE users.tenant_id = ${tenants.id} AND users.google_status IN ('expired', 'error'))`
      )
      .limit(20),
    db.select({ n: count() }).from(bookings).where(gte(bookings.createdAt, sevenDaysAgo)),
    // Plan catalog — for MRR pricing lookups.
    db.select({ slug: plans.slug, priceMonthlyCents: plans.priceMonthlyCents }).from(plans),
    // Plan + sub-status distribution. We compute MRR + revenue widgets
    // from this single grouped query rather than per-plan round trips.
    db
      .select({
        plan: tenants.currentPlan,
        status: tenants.subscriptionStatus,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(tenants)
      .groupBy(tenants.currentPlan, tenants.subscriptionStatus),
    // 30-day signup rate
    db.select({ n: count() }).from(tenants).where(gte(tenants.createdAt, thirtyDaysAgo)),
    // Trial → conversion proxy: count of tenants currently trialing
    // (window: those whose trial started in the last 30d).
    db
      .select({ n: count() })
      .from(tenants)
      .where(and(eq(tenants.subscriptionStatus, "trialing"), gte(tenants.createdAt, thirtyDaysAgo))),
    db
      .select({ n: count() })
      .from(tenants)
      .where(and(eq(tenants.subscriptionStatus, "active"), gte(tenants.createdAt, thirtyDaysAgo))),
  ]);

  // MRR: for each (plan, status='active') row, multiply tenant count by
  // the plan's monthly price. Trialing / past_due not counted as MRR.
  const priceBySlug = new Map(planRows.map((p) => [p.slug, p.priceMonthlyCents]));
  const mrrCents = tenantPlanDistribution.reduce((sum, row) => {
    if (row.status !== "active") return sum;
    const price = priceBySlug.get(row.plan) ?? 0;
    return sum + price * Number(row.n);
  }, 0);
  const planTotals: Record<string, number> = {};
  let trialingTotal = 0;
  let pastDueTotal = 0;
  for (const row of tenantPlanDistribution) {
    planTotals[row.plan] = (planTotals[row.plan] ?? 0) + Number(row.n);
    if (row.status === "trialing") trialingTotal += Number(row.n);
    if (row.status === "past_due") pastDueTotal += Number(row.n);
  }
  const newTrials = Number(newTrialsLast30d?.n ?? 0);
  const newConverted = Number(convertedLast30d?.n ?? 0);
  const trialDenominator = newTrials + newConverted;
  const trialConversionPct = trialDenominator > 0
    ? Math.round((newConverted / trialDenominator) * 100)
    : null;

  return (
    <Shell
      user={me ? { name: me.name, email: me.email, role: me.role } : { name: session.email, email: session.email, role: "admin" }}
      variant="super"
      title="Operations"
      crumbs={[{ label: "Super-admin" }, { label: "Overview" }]}
    >
      <div className="text-xs font-medium uppercase tracking-wider text-red-700">Internal — superuser only</div>
      <h1 className="mt-1 text-heading font-semibold text-ink">Operations</h1>

      <div className="mt-5">
        <OverviewExperience
          kpis={kpiBundle}
          totalTenants={allTenants.length}
          totalUsers={Number(usersTotal?.n ?? 0)}
          totalBookings={Number(bookingsTotal?.n ?? 0)}
          bookings7d={Number(recentBookings?.n ?? 0)}
          emailSent7d={Number(emailSent?.n ?? 0)}
          emailFailures7d={Number(emailFailures?.n ?? 0)}
          expiredGoogleCount={expiredGoogleTenants.length}
          mrrCents={mrrCents}
          trialingNow={trialingTotal}
          pastDueNow={pastDueTotal}
          tenantsNew30d={Number(tenantsNew30d?.n ?? 0)}
          trialConversionPct={trialConversionPct}
          planRows={Object.entries(planTotals)
            .sort(([, a], [, b]) => b - a)
            .map(([plan, total]) => {
              const active = tenantPlanDistribution.find((r) => r.plan === plan && r.status === "active");
              const trial = tenantPlanDistribution.find((r) => r.plan === plan && r.status === "trialing");
              const past = tenantPlanDistribution.find((r) => r.plan === plan && r.status === "past_due");
              const priceCents = priceBySlug.get(plan) ?? 0;
              const activeCount = Number(active?.n ?? 0);
              return {
                plan,
                total,
                active: activeCount,
                trialing: Number(trial?.n ?? 0),
                pastDue: Number(past?.n ?? 0),
                priceCents,
                mrrCents: priceCents * activeCount,
              };
            })}
        />
      </div>

      {/* Integration health — tenants whose Google connection broke */}
      <h2 className="mt-10 text-lg font-medium">Integration health</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        {expiredGoogleTenants.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-subtle">
            ✓ Every tenant&rsquo;s Google connection is healthy.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Tenant</th>
                <th className="px-4 py-2">Slug</th>
                <th className="px-4 py-2">Expired connections</th>
                <th className="px-4 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {expiredGoogleTenants.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className="px-4 py-2 font-medium">{t.name}</td>
                  <td className="px-4 py-2"><code className="text-xs">{t.slug}</code></td>
                  <td className="px-4 py-2"><Badge tone="red">{Number(t.users)} user(s)</Badge></td>
                  <td className="px-4 py-2 text-xs text-ink-muted">Tenant admin needs to reconnect</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="mt-10 text-lg font-medium">Tenants</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Slug</th>
              <th className="px-4 py-2">Plan</th>
              <th className="px-4 py-2">Sub status</th>
              <th className="px-4 py-2">Stripe</th>
              <th className="px-4 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {allTenants.map((t) => (
              <tr key={t.id} className="border-t">
                <td className="px-4 py-2 font-medium">{t.name}</td>
                <td className="px-4 py-2"><code className="text-xs">{t.slug}</code></td>
                <td className="px-4 py-2 capitalize">{t.plan}</td>
                <td className="px-4 py-2">{t.status ?? "—"}</td>
                <td className="px-4 py-2 text-xs">{t.stripeCustomerId ?? "—"}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{t.createdAt.toISOString().slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-lg font-medium">Recent audit log</h2>
      <div className="mt-3 overflow-hidden rounded-lg border bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Action</th>
              <th className="px-4 py-2">Actor</th>
              <th className="px-4 py-2">Entity</th>
              <th className="px-4 py-2">IP</th>
            </tr>
          </thead>
          <tbody>
            {recentAudit.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-sm text-slate-500">No audit entries yet.</td></tr>
            )}
            {recentAudit.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="px-4 py-2 font-mono text-xs">{a.createdAt.toISOString()}</td>
                <td className="px-4 py-2">{a.action}</td>
                <td className="px-4 py-2 text-xs">{a.actorLabel ?? "—"}</td>
                <td className="px-4 py-2 text-xs">{a.entityType ?? "—"}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{a.ip ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-6 text-xs text-ink-subtle">
        Authorization: <code>SUPER_ADMIN_EMAILS</code> env var (comma-separated).
      </p>
    </Shell>
  );
}

// Stat + formatCents removed — premium executive layer now handled by
// <OverviewExperience />. The legacy table sections below still render
// raw values inline.
