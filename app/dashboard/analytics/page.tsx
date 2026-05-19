import { redirect } from "next/navigation";
import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { analyticsDailySnapshots, bookings, services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import Shell from "@/components/dashboard/Shell";
import { generateInsights, type Insight } from "@/lib/analytics/insights";
import type { DailyAggregate, SnapshotExtras } from "@/lib/analytics/types";

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

  // ─── Snapshot-backed sections ───────────────────────────────────────
  // Load the last 30 days of analytics_daily_snapshots. Tenants who
  // haven't accumulated snapshots yet (new feature) get an empty array
  // — the UI gracefully shows "more data appearing soon" rather than
  // empty charts.
  const thirtyDayCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000)
    .toISOString().slice(0, 10);
  const snapshotRows = await db
    .select()
    .from(analyticsDailySnapshots)
    .where(
      and(
        eq(analyticsDailySnapshots.tenantId, user.tenantId),
        gte(analyticsDailySnapshots.snapshotDate, thirtyDayCutoff)
      )
    )
    .orderBy(asc(analyticsDailySnapshots.snapshotDate));

  const aggregates: DailyAggregate[] = snapshotRows.map((r) => ({
    tenantId: r.tenantId,
    snapshotDate: r.snapshotDate,
    totalBookings: r.totalBookings,
    completedBookings: r.completedBookings,
    cancelledBookings: r.cancelledBookings,
    noShowBookings: r.noShowBookings,
    recurringBookings: r.recurringBookings,
    waitlistJoins: r.waitlistJoins,
    waitlistConversions: r.waitlistConversions,
    reviewRequestsSent: r.reviewRequestsSent,
    reviewsCompleted: r.reviewsCompleted,
    reminderEmailsSent: r.reminderEmailsSent,
    reminderEmailsSuppressed: r.reminderEmailsSuppressed,
    followupsSent: r.followupsSent,
    averageBookingLeadHours: r.averageBookingLeadHours,
    extras: (r.extras as SnapshotExtras) ?? {},
  }));

  const insights = generateInsights(aggregates);

  // Sum-across-window totals for the section cards.
  const sumWindow = aggregates.reduce(
    (acc, s) => ({
      reminderEmailsSent: acc.reminderEmailsSent + s.reminderEmailsSent,
      reminderEmailsSuppressed: acc.reminderEmailsSuppressed + s.reminderEmailsSuppressed,
      reviewRequestsSent: acc.reviewRequestsSent + s.reviewRequestsSent,
      followupsSent: acc.followupsSent + s.followupsSent,
      waitlistJoins: acc.waitlistJoins + s.waitlistJoins,
      waitlistConversions: acc.waitlistConversions + s.waitlistConversions,
      recurringBookings: acc.recurringBookings + s.recurringBookings,
    }),
    {
      reminderEmailsSent: 0,
      reminderEmailsSuppressed: 0,
      reviewRequestsSent: 0,
      followupsSent: 0,
      waitlistJoins: 0,
      waitlistConversions: 0,
      recurringBookings: 0,
    }
  );

  // Aggregate per-staff counts across the snapshot window.
  const staffTotals: Record<string, number> = {};
  for (const s of aggregates) {
    const map = s.extras.staffAssignments ?? {};
    for (const [k, v] of Object.entries(map)) {
      staffTotals[k] = (staffTotals[k] ?? 0) + v;
    }
  }
  const staffRows = Object.entries(staffTotals)
    .map(([staffName, n]) => ({ staffName, count: n }))
    .sort((a, b) => b.count - a.count);
  const staffTotal = staffRows.reduce((acc, s) => acc + s.count, 0);

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

      {/* OPERATIONAL INSIGHTS — only shown when generators emit. */}
      {insights.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-medium">Operational insights</h2>
          <ul className="mt-3 space-y-2">
            {insights.map((it) => (
              <li
                key={it.code}
                className={
                  "rounded-lg border p-3 text-sm " +
                  (it.kind === "warning"
                    ? "border-amber-200 bg-amber-50 text-amber-900"
                    : it.kind === "positive"
                      ? "border-green-200 bg-green-50 text-green-900"
                      : "border-slate-200 bg-slate-50 text-slate-700")
                }
              >
                {it.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* SNAPSHOT-BACKED SECTIONS — show only when we have snapshot history. */}
      {aggregates.length > 0 ? (
        <>
          <div className="mt-10 flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-medium">Last {aggregates.length}-day rollup</h2>
            <a
              href="/api/tenant/analytics/export?range=30"
              className="text-xs text-slate-500 underline-offset-2 hover:text-slate-900 hover:underline"
            >
              ↓ Export CSV
            </a>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Reminder emails sent" value={String(sumWindow.reminderEmailsSent)} muted />
            <Stat label="Reminders suppressed" value={String(sumWindow.reminderEmailsSuppressed)} muted />
            <Stat label="Review requests sent" value={String(sumWindow.reviewRequestsSent)} muted />
            <Stat label="Follow-ups sent" value={String(sumWindow.followupsSent)} muted />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Waitlist joins" value={String(sumWindow.waitlistJoins)} muted />
            <Stat label="Waitlist conversions" value={String(sumWindow.waitlistConversions)} muted />
            <Stat label="Recurring bookings" value={String(sumWindow.recurringBookings)} muted />
          </div>

          {staffRows.length > 0 && (
            <>
              <h2 className="mt-10 text-lg font-medium">Staff utilization</h2>
              <div className="mt-3 rounded-lg border bg-white shadow-sm">
                <ul className="divide-y">
                  {staffRows.slice(0, 8).map((s) => {
                    const share = staffTotal > 0 ? Math.round((s.count / staffTotal) * 100) : 0;
                    return (
                      <li key={s.staffName} className="px-4 py-3 text-sm">
                        <div className="flex items-center justify-between">
                          <span className="truncate">{s.staffName}</span>
                          <span className="text-slate-500 tabular-nums">
                            {s.count} ({share}%)
                          </span>
                        </div>
                        <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                          <div
                            className="h-1.5 rounded-full bg-blue-500"
                            style={{ width: `${share}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </>
          )}
        </>
      ) : (
        <div className="mt-10 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
          More analytics appear once daily snapshots accumulate. The
          first snapshot is generated overnight; backfill is available
          via <code className="font-mono text-xs">BACKFILL_DAYS</code>.
        </div>
      )}

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
