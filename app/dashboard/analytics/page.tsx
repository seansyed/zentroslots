import { redirect } from "next/navigation";
import { and, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { bookings, services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import Shell from "@/components/dashboard/Shell";

export default async function AnalyticsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const shellProps = {
    user: { name: user.name, email: user.email, role: user.role },
    tenant: { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl },
    title: "Analytics",
    crumbs: [{ label: "Dashboard", href: "/dashboard" }, { label: "Analytics" }],
  };

  if (!planFeature(tenant.currentPlan, "analytics")) {
    return (
      <Shell {...shellProps}>
        <h1 className="text-heading font-semibold text-ink">Analytics</h1>
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          Analytics is a Pro feature.{" "}
          <a href="/dashboard/billing" className="font-medium underline">Upgrade your plan</a> to unlock charts and revenue estimates.
        </div>
      </Shell>
    );
  }

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthAgo30 = new Date(now); monthAgo30.setDate(monthAgo30.getDate() - 30);
  const tenantOnly = eq(bookings.tenantId, user.tenantId);

  const [[monthCount], [createdMonth], [cancelMonth], [completedMonth], [revenueMonthRow]] = await Promise.all([
    db.select({ n: count() }).from(bookings).where(and(tenantOnly, eq(bookings.status, "confirmed"), gte(bookings.startAt, startOfMonth))),
    db.select({ n: count() }).from(bookings).where(and(tenantOnly, gte(bookings.createdAt, startOfMonth))),
    db.select({ n: count() }).from(bookings).where(and(tenantOnly, eq(bookings.status, "cancelled"), gte(bookings.createdAt, startOfMonth))),
    db.select({ n: count() }).from(bookings).where(and(tenantOnly, eq(bookings.status, "completed"), gte(bookings.createdAt, startOfMonth))),
    db
      .select({ revenue: sql<number>`COALESCE(SUM(${services.price})::int, 0)` })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .where(and(tenantOnly, eq(bookings.status, "confirmed"), gte(bookings.startAt, startOfMonth))),
  ]);

  // Top services this month
  const topServices = await db
    .select({
      id: services.id,
      name: services.name,
      n: count(bookings.id),
    })
    .from(bookings)
    .innerJoin(services, eq(services.id, bookings.serviceId))
    .where(and(tenantOnly, gte(bookings.startAt, startOfMonth)))
    .groupBy(services.id, services.name)
    .orderBy(desc(count(bookings.id)))
    .limit(5);

  // Daily bookings created over the last 30 days
  const dailyRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${bookings.createdAt}), 'YYYY-MM-DD')`,
      n: count(),
    })
    .from(bookings)
    .where(and(tenantOnly, gte(bookings.createdAt, monthAgo30)))
    .groupBy(sql`date_trunc('day', ${bookings.createdAt})`)
    .orderBy(sql`date_trunc('day', ${bookings.createdAt})`);

  const dailyMap = new Map(dailyRows.map((r) => [r.day, Number(r.n)]));
  const days: { label: string; n: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ label: key, n: dailyMap.get(key) ?? 0 });
  }

  const created = Number(createdMonth?.n ?? 0);
  const cancelled = Number(cancelMonth?.n ?? 0);
  const conversionPct = created > 0 ? Math.round(((created - cancelled) / created) * 100) : 0;
  const revenue = Number(revenueMonthRow?.revenue ?? 0);

  return (
    <Shell {...shellProps}>
      <h1 className="text-heading font-semibold text-ink">Analytics</h1>
      <p className="mt-1 text-sm text-ink-muted">This month at a glance.</p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Bookings (created)" value={String(created)} />
        <Stat label="Confirmed (month)" value={String(Number(monthCount?.n ?? 0))} />
        <Stat label="Conversion" value={`${conversionPct}%`} />
        <Stat label="Revenue est." value={`$${(revenue / 100).toFixed(0)}`} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Completed" value={String(Number(completedMonth?.n ?? 0))} muted />
        <Stat label="Cancelled" value={String(cancelled)} muted />
        <Stat label="Top service" value={topServices[0]?.name ?? "—"} muted />
      </div>

      <h2 className="mt-10 text-lg font-medium">Bookings — last 30 days</h2>
      <div className="mt-3 rounded-lg border bg-white p-4 shadow-sm">
        <BarChart days={days} />
      </div>

      <h2 className="mt-10 text-lg font-medium">Top services this month</h2>
      <div className="mt-3 rounded-lg border bg-white shadow-sm">
        {topServices.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">No bookings yet this month.</div>
        ) : (
          <ul className="divide-y">
            {topServices.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span>{s.name}</span>
                <span className="text-slate-500">{Number(s.n)} bookings</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Shell>
  );
}

function Stat({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={"rounded-lg border bg-white p-4 shadow-sm " + (muted ? "opacity-90" : "")}>
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function BarChart({ days }: { days: { label: string; n: number }[] }) {
  const W = 720;
  const H = 160;
  const PAD = 24;
  const max = Math.max(1, ...days.map((d) => d.n));
  const barWidth = (W - PAD * 2) / days.length - 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
      {/* axis */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e2e8f0" />
      {days.map((d, i) => {
        const h = ((d.n / max) * (H - PAD * 2)) || 0;
        const x = PAD + i * ((W - PAD * 2) / days.length);
        const y = H - PAD - h;
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={Math.max(2, barWidth)} height={h} fill="#2563eb" rx="2">
              <title>{d.label}: {d.n}</title>
            </rect>
          </g>
        );
      })}
      <text x={PAD} y={H - 4} fontSize="10" fill="#94a3b8">{days[0]?.label}</text>
      <text x={W - PAD} y={H - 4} fontSize="10" fill="#94a3b8" textAnchor="end">{days[days.length - 1]?.label}</text>
    </svg>
  );
}
