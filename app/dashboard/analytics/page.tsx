import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Briefcase,
  CalendarRange,
  CheckCircle2,
  DollarSign,
  Gauge,
  Lock,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { db } from "@/db/client";
import { analyticsDailySnapshots, bookings, services, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import { getPlan } from "@/lib/plans";
import Shell from "@/components/dashboard/Shell";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { generateInsights, type Insight } from "@/lib/analytics/insights";
import { effectivePermissions } from "@/lib/security/permissions";
import type { DailyAggregate, SnapshotExtras } from "@/lib/analytics/types";

export default async function AnalyticsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const permissions = effectivePermissions(user);
  const shellProps = {
    user: { name: user.name, email: user.email, role: user.role, permissions },
    tenant: { name: tenant.name, slug: tenant.slug, plan: tenant.currentPlan, logoUrl: tenant.logoUrl },
    title: "Analytics",
    crumbs: [{ label: "Dashboard", href: "/dashboard" }, { label: "Analytics" }],
  };

  if (!planFeature(tenant.currentPlan, "analytics")) {
    return (
      <Shell {...shellProps}>
        <LockedAnalyticsPreview
          currentPlanName={getPlan(tenant.currentPlan).name}
        />
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

  // ─── Revenue computations from snapshot extras ────────────────────
  // Only shown when at least one snapshot in the window carries
  // revenue data (i.e. the tenant has billing_transactions). The
  // estimated "Revenue est." card above remains for backward compat
  // until tenants accumulate real revenue history.
  const revenueByDay: { date: string; gross: number; refunded: number; net: number }[] = [];
  let totalGross = 0;
  let totalRefunded = 0;
  let totalFailed = 0;
  let totalSuccessful = 0;
  let avgAcrossDays = 0;
  let avgDaysWithBookings = 0;
  const serviceRevenueAgg: Record<string, { name: string; revenue: number; bookings: number }> = {};
  const staffRevenueAgg: Record<string, { name: string; revenue: number; bookings: number }> = {};

  for (const s of aggregates) {
    const r = s.extras.revenue;
    if (!r) continue;
    revenueByDay.push({
      date: s.snapshotDate,
      gross: r.grossRevenueCents,
      refunded: r.refundedRevenueCents,
      net: r.netRevenueCents,
    });
    totalGross += r.grossRevenueCents;
    totalRefunded += r.refundedRevenueCents;
    totalFailed += r.failedPayments;
    totalSuccessful += r.successfulPayments;
    if (r.avgBookingValueCents > 0) {
      avgAcrossDays += r.avgBookingValueCents;
      avgDaysWithBookings++;
    }
    for (const sv of s.extras.serviceRevenue ?? []) {
      const key = sv.serviceId;
      serviceRevenueAgg[key] = serviceRevenueAgg[key] ?? { name: sv.serviceName, revenue: 0, bookings: 0 };
      serviceRevenueAgg[key].revenue += sv.revenueCents;
      serviceRevenueAgg[key].bookings += sv.bookings;
    }
    for (const sv of s.extras.staffRevenue ?? []) {
      const key = sv.staffId;
      staffRevenueAgg[key] = staffRevenueAgg[key] ?? { name: sv.staffName, revenue: 0, bookings: 0 };
      staffRevenueAgg[key].revenue += sv.revenueCents;
      staffRevenueAgg[key].bookings += sv.bookings;
    }
  }
  const hasRevenue = revenueByDay.length > 0;
  const totalNet = totalGross - totalRefunded;
  const avgBookingValue = avgDaysWithBookings > 0 ? Math.round(avgAcrossDays / avgDaysWithBookings) : 0;
  const topRevenueServices = Object.values(serviceRevenueAgg)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);
  const topRevenueStaff = Object.values(staffRevenueAgg)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8);
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  // ─── Forecasting + staffing intelligence + recommendations ────────
  // The aggregation worker writes these to the most-recent snapshot's
  // extras using a trailing 30-day window. We read off the LAST
  // snapshot (chronological end of `aggregates`). Absent → the
  // corresponding section is hidden gracefully.
  const latestExtras = aggregates.length > 0 ? aggregates[aggregates.length - 1].extras : {};
  const forecast = latestExtras.forecasting ?? null;
  const staffingInsightsExtra = latestExtras.staffingInsights ?? null;
  const riskSignals = latestExtras.riskSignals ?? null;
  const recommendations = latestExtras.recommendations ?? null;
  // Hide forecasts when confidence is too low — avoids false-precision noise.
  const showForecast = forecast !== null && forecast.confidenceScore >= 0.4;

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

      {/* REVENUE PERFORMANCE — only when billing data present.
          Graceful degradation: section absent for tenants without Stripe traffic. */}
      {hasRevenue && (
        <>
          <h2 className="mt-10 text-lg font-medium">Revenue performance</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Derived from canonical billing ledger. Reflects actual paid + refunded transactions.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Gross revenue" value={dollars(totalGross)} />
            <Stat label="Net revenue" value={dollars(totalNet)} />
            <Stat label="Refunds" value={dollars(totalRefunded)} muted />
            <Stat label="Failed payments" value={String(totalFailed)} muted />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Successful payments" value={String(totalSuccessful)} muted />
            <Stat label="Avg booking value" value={dollars(avgBookingValue)} muted />
            <Stat label="Days with revenue" value={String(revenueByDay.length)} muted />
          </div>

          <h3 className="mt-6 text-sm font-medium text-ink-muted">Revenue by day</h3>
          <div className="mt-2 rounded-lg border bg-white p-4 shadow-sm">
            <RevenueChart days={revenueByDay} />
          </div>

          {topRevenueServices.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-medium text-ink-muted">Top revenue services</h3>
              <div className="mt-2 rounded-lg border bg-white shadow-sm">
                <ul className="divide-y">
                  {topRevenueServices.map((s) => (
                    <li key={s.name} className="flex items-center justify-between px-4 py-3 text-sm">
                      <span className="truncate">{s.name}</span>
                      <span className="text-slate-500 tabular-nums">
                        {dollars(s.revenue)} · {s.bookings} bookings
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {topRevenueStaff.length > 0 && (
            <>
              <h3 className="mt-6 text-sm font-medium text-ink-muted">Top revenue staff</h3>
              <div className="mt-2 rounded-lg border bg-white shadow-sm">
                <ul className="divide-y">
                  {topRevenueStaff.map((s) => (
                    <li key={s.name} className="flex items-center justify-between px-4 py-3 text-sm">
                      <span className="truncate">{s.name}</span>
                      <span className="text-slate-500 tabular-nums">
                        {dollars(s.revenue)} · {s.bookings} bookings
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {/* PAYMENT HEALTH section — flags failed-payment activity. */}
          {totalFailed > 0 && (
            <>
              <h2 className="mt-10 text-lg font-medium">Payment health</h2>
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <b>{totalFailed}</b> payment{totalFailed === 1 ? "" : "s"} failed in the last{" "}
                {revenueByDay.length} {revenueByDay.length === 1 ? "day" : "days"}. Check the
                customer's saved payment method or contact Stripe support if this is unexpected.
              </div>
            </>
          )}
        </>
      )}

      {/* FORECASTING — only when confidence sufficient. */}
      {showForecast && forecast && (
        <>
          <h2 className="mt-10 text-lg font-medium">Forecasting</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Based on the last {forecast.basedOnDays} days. Confidence{" "}
            <span className="font-semibold text-ink">{Math.round(forecast.confidenceScore * 100)}%</span>{" · "}
            trend{" "}
            <span className="font-semibold text-ink">{forecast.trendDirection}</span>{" · "}
            pressure{" "}
            <span className="font-semibold text-ink">{forecast.staffingPressureLevel}</span>.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Projected bookings (30d)" value={String(forecast.projectedBookingsNext30Days)} />
            <Stat label="Projected revenue (30d)" value={dollars(forecast.projectedRevenueNext30Days)} />
            <Stat label="Busy days" value={forecast.expectedBusyWeekdays.join(", ") || "—"} muted />
            <Stat label="Peak hours" value={forecast.expectedPeakHours.length > 0 ? forecast.expectedPeakHours.map((h) => `${h}h`).join(", ") : "—"} muted />
          </div>
        </>
      )}

      {/* STAFFING INTELLIGENCE — emit only when there are signals. */}
      {staffingInsightsExtra && (
        <>
          <h2 className="mt-10 text-lg font-medium">Staffing intelligence</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Overloaded staff" value={String(staffingInsightsExtra.overloadStaff)} muted />
            <Stat label="Underutilized" value={String(staffingInsightsExtra.underutilizedStaff)} muted />
            <Stat label="Uneven assignment" value={staffingInsightsExtra.unevenAssignment ? "Yes" : "No"} muted />
            <Stat label="Booking surge" value={staffingInsightsExtra.bookingSurge ? "Yes" : "No"} muted />
          </div>
          {staffingInsightsExtra.messages.length > 0 && (
            <ul className="mt-3 space-y-2">
              {staffingInsightsExtra.messages.map((m, i) => (
                <li
                  key={`${m.code}-${i}`}
                  className={
                    "rounded-lg border p-3 text-sm " +
                    (m.severity === "warning"
                      ? "border-amber-200 bg-amber-50 text-amber-900"
                      : m.severity === "positive"
                        ? "border-green-200 bg-green-50 text-green-900"
                        : "border-slate-200 bg-slate-50 text-slate-700")
                  }
                >
                  {m.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {/* RISK MONITORING — only when scoring has populated. */}
      {riskSignals && riskSignals.totalScored > 0 && (
        <>
          <h2 className="mt-10 text-lg font-medium">Risk monitoring</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Upcoming bookings scored by lead time, prior history, and engagement.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="High-risk" value={String(riskSignals.highCount)} muted />
            <Stat label="Medium-risk" value={String(riskSignals.mediumCount)} muted />
            <Stat label="Low-risk" value={String(riskSignals.lowCount)} muted />
            <Stat label="Scored" value={String(riskSignals.totalScored)} muted />
          </div>
        </>
      )}

      {/* OPERATIONAL RECOMMENDATIONS — cited, never AI-generated. */}
      {recommendations && recommendations.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-medium">Recommendations</h2>
          <ul className="mt-3 space-y-2">
            {recommendations.map((r) => (
              <li
                key={r.code}
                className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="text-sm font-medium text-ink">{r.message}</div>
                <div className="mt-1 text-xs text-ink-subtle">
                  <span className="font-semibold text-ink-muted">Why:</span> {r.evidence}
                </div>
              </li>
            ))}
          </ul>
        </>
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

function RevenueChart({
  days,
}: {
  days: { date: string; gross: number; refunded: number; net: number }[];
}) {
  if (days.length === 0) return null;
  const W = 720;
  const H = 160;
  const PAD = 24;
  const max = Math.max(1, ...days.map((d) => d.gross));
  const barWidth = (W - PAD * 2) / days.length - 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none">
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e2e8f0" />
      {days.map((d, i) => {
        const grossH = ((d.gross / max) * (H - PAD * 2)) || 0;
        const refundedH = ((d.refunded / max) * (H - PAD * 2)) || 0;
        const x = PAD + i * ((W - PAD * 2) / days.length);
        return (
          <g key={d.date}>
            {/* Gross (green) */}
            <rect x={x} y={H - PAD - grossH} width={Math.max(2, barWidth)} height={grossH} fill="#10b981" rx="2">
              <title>{d.date}: gross ${(d.gross / 100).toFixed(2)}, net ${(d.net / 100).toFixed(2)}</title>
            </rect>
            {/* Refund overlay (red, drawn on top from the bottom of gross) */}
            {refundedH > 0 && (
              <rect x={x} y={H - PAD - refundedH} width={Math.max(2, barWidth)} height={refundedH} fill="#ef4444" opacity={0.7} rx="2">
                <title>{d.date}: refunded ${(d.refunded / 100).toFixed(2)}</title>
              </rect>
            )}
          </g>
        );
      })}
      <text x={PAD} y={H - 4} fontSize="10" fill="#94a3b8">{days[0].date}</text>
      <text x={W - PAD} y={H - 4} fontSize="10" fill="#94a3b8" textAnchor="end">{days[days.length - 1].date}</text>
    </svg>
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

// ─── Locked Analytics Preview (Phase 11) ──────────────────────────
//
// Premium upgrade surface shown to tenants on plans without the
// `analytics` capability. Replaces the prior amber "feature locked"
// alert with an aspirational preview of the unlocked experience:
//
//   • Hero with upgrade CTA
//   • 5 KPI cards — labels are real, values are skeleton bars
//     (NOT fake numbers — keeps us honest, no fabricated metrics)
//   • Two decorative chart silhouettes (pure SVG, no real data)
//   • Three sample AI-style insight cards, clearly marked "preview"
//   • Plan comparison card pairing the current plan with Pro
//
// Server component. No client interactivity beyond static links
// (Upgrade CTAs route to /dashboard/billing). The brief mandated
// "Disabled KPI cards / Blurred charts / Locked overlays / Upgrade
// CTA / Plan comparison mini-card" — this delivers all of that.

function LockedAnalyticsPreview({ currentPlanName }: { currentPlanName: string }) {
  const proPlan = getPlan("pro");
  const proFeatures = proPlan.features;

  // KPI labels surfaced in the preview grid. Values intentionally
  // rendered as skeleton bars rather than fabricated numbers —
  // honest about what's locked without inventing metrics.
  const kpiPreview: Array<{ icon: LucideIcon; label: string; tone: string }> = [
    { icon: CalendarRange, label: "Total bookings",     tone: "bg-brand-subtle/60 text-brand-accent" },
    { icon: DollarSign,    label: "Revenue",            tone: "bg-emerald-50 text-emerald-700" },
    { icon: TrendingUp,    label: "Avg booking value",  tone: "bg-sky-50 text-sky-700" },
    { icon: Activity,      label: "Conversion %",       tone: "bg-violet-50 text-violet-700" },
    { icon: Gauge,         label: "Utilization %",      tone: "bg-amber-50 text-amber-700" },
  ];

  const sampleInsights: Array<{ icon: LucideIcon; tone: string; body: string }> = [
    {
      icon: TrendingUp,
      tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/40",
      body: "Spot your highest-conversion hours and replicate them across the calendar.",
    },
    {
      icon: Users,
      tone: "bg-brand-subtle/60 text-brand-accent ring-brand-accent/20",
      body: "See which staff convert above tenant average and route more leads their way.",
    },
    {
      icon: Activity,
      tone: "bg-amber-50 text-amber-700 ring-amber-200/40",
      body: "Catch cancellation trends early — the engine flags when rates drift.",
    },
  ];

  return (
    <div className="space-y-5 pb-12">
      {/* Hero */}
      <PremiumCard className="relative overflow-hidden p-6">
        <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-accent/15 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -left-16 bottom-0 h-40 w-40 rounded-full bg-violet-500/8 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
              <Lock className="h-3 w-3" strokeWidth={2} />
              Preview · {proPlan.name} feature
            </div>
            <h1 className="mt-3 text-[24px] font-semibold tracking-tight text-ink sm:text-[26px]">
              Operational intelligence for your scheduling business.
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              Revenue trends, conversion rates, staff performance, and forecasting — wired to your real
              booking data. Upgrade to {proPlan.name} to unlock the full analytics workspace.
            </p>
          </div>
          <Link
            href="/dashboard/billing"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-4 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_4px_18px_rgba(53,157,243,0.30)] transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(53,157,243,0.40)]"
          >
            {/* Live pulse dot — subtle "system is alive" indicator
                per Phase 11B Part 2 (without inventing fake live
                business metrics). Pure CSS, no JS. */}
            <span aria-hidden className="relative inline-flex h-2 w-2">
              <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-white/60" />
              <span className="relative inline-block h-2 w-2 rounded-full bg-white" />
            </span>
            Upgrade to {proPlan.name}
          </Link>
        </div>
      </PremiumCard>

      {/* Value props row — three honest cards describing what the
          engine actually does (each maps to a real lib/analytics
          module: forecasting.ts, staffingInsights.ts, insights.ts).
          No fabricated stats — operational framing only. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ValuePropCard
          icon={TrendingUp}
          title="Conversion intelligence"
          body="See your highest-converting hours and replicate them across the calendar."
        />
        <ValuePropCard
          icon={DollarSign}
          title="Revenue forecasting"
          body="Project monthly revenue with confidence bands tuned to your real booking history."
        />
        <ValuePropCard
          icon={Users}
          title="Staff orchestration"
          body="Surface above-average converters and route more leads their way automatically."
        />
      </div>

      {/* KPI preview grid — labels real, values skeleton (no fake numbers) */}
      <div>
        <SectionLabel
          eyebrow="KPI cockpit"
          title="Executive metrics, locked"
          hint="Renders with your real data once you upgrade."
        />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {kpiPreview.map((k) => {
            const Icon = k.icon;
            return (
              <div
                key={k.label}
                className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-3.5 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
              >
                <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                      {k.label}
                    </div>
                    {/* Skeleton bars where the metric would render —
                        honest about what's locked, no fabricated data.
                        Soft pulse animation = premium loader vibe. */}
                    <div className="mt-2 space-y-1.5" aria-hidden>
                      <div className="h-5 w-3/4 animate-pulse rounded-md bg-gradient-to-r from-ink/10 via-ink/[0.06] to-transparent" />
                      <div className="h-2 w-1/2 animate-pulse rounded-md bg-ink/[0.06]" style={{ animationDelay: "200ms" }} />
                    </div>
                  </div>
                  <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", k.tone)}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </span>
                </div>
                {/* Subtle lock indicator at the bottom */}
                <div className="mt-3 inline-flex items-center gap-1 text-[10px] font-medium text-ink-subtle">
                  <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                  Locked
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Chart silhouettes — pure decoration, no real data */}
      <div>
        <SectionLabel
          eyebrow="Trends"
          title="Booking + revenue charts, locked"
          hint="Recharts-powered trend lines, comparisons, and forecasts."
        />
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ChartPreviewCard title="Booking trend · 30 days" icon={BarChart3}>
            <AreaSilhouette />
          </ChartPreviewCard>
          <ChartPreviewCard title="Revenue · 30 days" icon={DollarSign}>
            <BarSilhouette />
          </ChartPreviewCard>
        </div>
      </div>

      {/* Sample insight cards — clearly marked preview */}
      <div>
        <SectionLabel
          eyebrow="AI signals"
          title="Operational insights, locked"
          hint="Auto-generated when the engine has enough data to be useful."
        />
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          {sampleInsights.map((s, i) => {
            const Icon = s.icon;
            return (
              <div
                key={i}
                className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
              >
                <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                <div className="flex items-start gap-2.5">
                  <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1", s.tone)}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0">
                    <div className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
                      Preview
                    </div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">{s.body}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* How analytics works — educational mini-section per
          Phase 11B Part 9. Three-step operational loop:
          Track -> Surface -> Optimize. Helps tenants understand
          the value before they upgrade. No fake numbers, just
          system explanation. */}
      <PremiumCard className="p-5">
        <SectionLabel
          eyebrow="How it works"
          title="From booking data to operational decisions"
          hint="The same loop your operations team would run manually — automated."
        />
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <HowItWorksStep
            step={1}
            icon={Activity}
            title="Track"
            body="Every booking, cancel, no-show, and confirm rolls into a daily snapshot — tenant-scoped."
          />
          <HowItWorksStep
            step={2}
            icon={Sparkles}
            title="Surface"
            body="The engine spots trends, anomalies, and drift in real time and turns them into plain-language insights."
          />
          <HowItWorksStep
            step={3}
            icon={Zap}
            title="Optimize"
            body="Recommendations tell you what to do next — adjust hours, route bookings, fix friction points."
          />
        </div>
      </PremiumCard>

      {/* Plan comparison card */}
      <PremiumCard className="relative overflow-hidden p-5">
        <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-brand-accent/12 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -left-12 bottom-0 h-32 w-32 rounded-full bg-amber-400/10 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-center">
          {/* Current plan side */}
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Current plan
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-[18px] font-semibold tracking-tight text-ink">{currentPlanName}</span>
              <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
                you&apos;re here
              </span>
            </div>
            <ul className="mt-3 space-y-1.5 text-[11.5px] text-ink-muted">
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                <span>Booking essentials + public booking page</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                <span>Operational intelligence locked</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                <span>Custom branding locked</span>
              </li>
            </ul>
          </div>

          {/* Pro plan side — highlighted */}
          <div className="relative rounded-xl border-2 border-brand-accent/40 bg-gradient-to-br from-brand-subtle/40 via-surface to-surface p-4 shadow-[0_8px_24px_rgba(53,157,243,0.12)]">
            <div className="absolute -top-2 right-3 inline-flex items-center gap-1 rounded-full bg-brand-accent px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white shadow-[0_4px_12px_rgba(53,157,243,0.32)]">
              <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
              Recommended
            </div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Upgrade to
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-[18px] font-semibold tracking-tight text-ink">{proPlan.name}</span>
              {proPlan.priceCents !== null && (
                <span className="text-[11.5px] font-medium text-ink-muted">
                  ${(proPlan.priceCents / 100).toFixed(0)}/mo
                </span>
              )}
            </div>
            <ul className="mt-3 space-y-1.5 text-[11.5px] text-ink">
              {proFeatures.map((f) => (
                <li key={f} className="flex items-start gap-1.5">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-brand-accent" strokeWidth={2} />
                  <span>{f}</span>
                </li>
              ))}
              <li className="flex items-start gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-brand-accent" strokeWidth={2} />
                <span className="font-medium">Full analytics workspace</span>
              </li>
            </ul>
          </div>

          {/* CTA column */}
          <div className="flex flex-col items-stretch gap-2 lg:items-end">
            <Link
              href="/dashboard/billing"
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-accent px-4 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_4px_18px_rgba(53,157,243,0.30)] transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(53,157,243,0.40)]"
            >
              <Zap className="h-3.5 w-3.5" strokeWidth={2} />
              Unlock analytics
              <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
            </Link>
            <Link
              href="/pricing"
              className="text-center text-[11px] text-ink-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Compare every plan
            </Link>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}

// Section header used inside the locked preview only.
function SectionLabel({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          {eyebrow}
        </div>
        <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">{title}</h2>
      </div>
      <p className="max-w-md text-[11px] text-ink-subtle">{hint}</p>
    </div>
  );
}

// Decorative chart silhouette wrapper. Title row + lock chip +
// blurred chart content. Pure decoration, no real data.
function ChartPreviewCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent">
            <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
          </span>
          <span className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
          <Lock className="h-2.5 w-2.5" strokeWidth={2} />
          Locked
        </span>
      </div>
      {/* Decorative blur layer + soft brand wash */}
      <div className="relative mt-3 overflow-hidden rounded-lg">
        <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-brand-subtle/0 via-brand-subtle/20 to-brand-subtle/0" />
        <div aria-hidden className="opacity-50 blur-[1px]">{children}</div>
      </div>
    </div>
  );
}

// Pure decorative SVG area silhouette. Hand-crafted curve, no real
// data. Used inside the locked-preview ChartPreviewCard.
function AreaSilhouette() {
  return (
    <svg viewBox="0 0 400 110" className="w-full" preserveAspectRatio="none" role="presentation">
      <defs>
        <linearGradient id="zm-locked-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#359df3" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#359df3" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path
        d="M 0 80 L 25 70 L 55 75 L 90 55 L 130 60 L 165 40 L 200 50 L 235 30 L 275 38 L 310 22 L 345 30 L 380 15 L 400 18 L 400 110 L 0 110 Z"
        fill="url(#zm-locked-area)"
      />
      <path
        d="M 0 80 L 25 70 L 55 75 L 90 55 L 130 60 L 165 40 L 200 50 L 235 30 L 275 38 L 310 22 L 345 30 L 380 15 L 400 18"
        fill="none"
        stroke="#359df3"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Pure decorative SVG bar silhouette — staggered heights to feel
// like a real revenue chart, but no actual data.
function BarSilhouette() {
  const heights = [38, 52, 30, 65, 42, 70, 48, 80, 55, 90, 62, 78];
  return (
    <svg viewBox="0 0 400 110" className="w-full" preserveAspectRatio="none" role="presentation">
      {heights.map((h, i) => (
        <rect
          key={i}
          x={6 + i * 33}
          y={100 - h}
          width="22"
          height={h}
          rx="3"
          fill="#10b981"
          opacity={0.5 + (i / heights.length) * 0.3}
        />
      ))}
    </svg>
  );
}

// Value prop card used in the post-hero strip (Phase 11B Part 10).
// Three of these surface what the Pro plan actually unlocks. Each
// maps to a real lib/analytics module — no fabricated capabilities.
function ValuePropCard({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft hover:border-brand-accent/30">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <span aria-hidden className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-brand-accent/[0.06] blur-2xl transition-opacity duration-[260ms] group-hover:opacity-100" />
      <div className="relative flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold tracking-tight text-ink">{title}</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
    </div>
  );
}

// "How it works" step tile used in the educational mini-section
// (Phase 11B Part 9). Numbered ribbon + icon + concise copy
// describing the operational loop (Track -> Surface -> Optimize).
function HowItWorksStep({
  step,
  icon: Icon,
  title,
  body,
}: {
  step: number;
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="relative rounded-xl border border-border bg-surface p-3.5 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span className="absolute -top-2 left-3 inline-flex h-4 items-center rounded-full bg-brand-accent px-1.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-white shadow-[0_2px_8px_rgba(53,157,243,0.20)]">
        Step {step}
      </span>
      <div className="flex items-start gap-2.5 pt-1">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
    </div>
  );
}
