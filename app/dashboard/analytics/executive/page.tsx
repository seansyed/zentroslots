import { redirect } from "next/navigation";
import { and, asc, eq, gte, lte } from "drizzle-orm";

import { db } from "@/db/client";
import { analyticsDailySnapshots, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import Shell from "@/components/dashboard/Shell";
import { buildExecutiveSummary } from "@/lib/analytics/executiveMetrics";
import {
  aggregateLocationAnalytics,
  aggregateDepartmentAnalytics,
} from "@/lib/analytics/locationAnalytics";
import {
  aggregateCustomerIntelligence,
  loadRepeatCustomerForComparison,
} from "@/lib/analytics/customerIntelligence";
import { buildOptimizationRecommendations } from "@/lib/analytics/optimizationEngine";
import type { DailyAggregate, SnapshotExtras } from "@/lib/analytics/types";

export const metadata = { title: "Executive analytics" };
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 60; // 30 vs 30

export default async function ExecutiveAnalyticsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const shellProps = {
    user: { name: user.name, email: user.email, role: user.role },
    tenant: {
      name: tenant.name,
      slug: tenant.slug,
      plan: tenant.currentPlan,
      logoUrl: tenant.logoUrl,
    },
    title: "Executive analytics",
    crumbs: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Analytics", href: "/dashboard/analytics" },
      { label: "Executive" },
    ],
  };

  if (!planFeature(tenant.currentPlan, "analytics")) {
    return (
      <Shell {...shellProps}>
        <h1 className="text-heading font-semibold text-ink">Executive analytics</h1>
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
          Executive analytics is a Pro feature.{" "}
          <a href="/dashboard/billing" className="font-medium underline">
            Upgrade your plan
          </a>{" "}
          to unlock KPI trends.
        </div>
      </Shell>
    );
  }

  const today = new Date();
  const cutoff = new Date(today.getTime() - WINDOW_DAYS * 24 * 60 * 60_000);
  const halfDays = Math.floor(WINDOW_DAYS / 2);
  const currentStart = new Date(today.getTime() - halfDays * 24 * 60 * 60_000);
  const prevStart = cutoff;

  const snapshotRows = await db
    .select()
    .from(analyticsDailySnapshots)
    .where(
      and(
        eq(analyticsDailySnapshots.tenantId, user.tenantId),
        gte(analyticsDailySnapshots.snapshotDate, cutoff.toISOString().slice(0, 10)),
        lte(analyticsDailySnapshots.snapshotDate, today.toISOString().slice(0, 10))
      )
    )
    .orderBy(asc(analyticsDailySnapshots.snapshotDate));

  const snapshots: DailyAggregate[] = snapshotRows.map((r) => ({
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

  const repeatCustomerData = await loadRepeatCustomerForComparison({
    tenantId: user.tenantId,
    currentStart,
    currentEnd: today,
    prevStart,
    prevEnd: currentStart,
  });
  const exec = buildExecutiveSummary(snapshots, repeatCustomerData);

  const [locations, departments, customerIntel] = await Promise.all([
    aggregateLocationAnalytics({ tenantId: user.tenantId, windowStart: currentStart, windowEnd: today }),
    aggregateDepartmentAnalytics({ tenantId: user.tenantId, windowStart: currentStart, windowEnd: today }),
    aggregateCustomerIntelligence({ tenantId: user.tenantId, windowStart: currentStart, windowEnd: today }),
  ]);

  const hasLocations = locations.length > 0;
  const hasDepartments = departments.length > 0;
  const hasCustomerData =
    customerIntel.bookingsByExistingCustomers + customerIntel.bookingsByNewCustomers > 0;

  // Optimization recommendations — recompute at request time with the
  // customer intelligence we just loaded. Gracefully empty when sparse.
  const optimizationRecs = (() => {
    try {
      return buildOptimizationRecommendations({
        snapshots,
        customerIntelligence: hasCustomerData ? customerIntel : null,
      });
    } catch {
      return [];
    }
  })();
  const recsByCategory = optimizationRecs.reduce<
    Record<string, typeof optimizationRecs>
  >((acc, r) => {
    (acc[r.category] = acc[r.category] ?? []).push(r);
    return acc;
  }, {});
  const CATEGORY_ORDER: Array<[string, string]> = [
    ["staffing", "Staffing"],
    ["scheduling", "Availability & scheduling"],
    ["reminders", "No-show prevention"],
    ["revenue", "Revenue optimization"],
    ["waitlist", "Waitlist optimization"],
    ["customer_retention", "Customer retention"],
  ];

  return (
    <Shell {...shellProps}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-heading font-semibold text-ink">Executive analytics</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            Business-level KPIs comparing the last {halfDays} days against the prior {halfDays}.
          </p>
        </div>
        <a
          href={`/api/tenant/analytics/executive/export?range=${WINDOW_DAYS}`}
          className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-ink hover:bg-surface-inset"
        >
          ↓ Export executive CSV
        </a>
      </div>

      {/* EXECUTIVE SUMMARY */}
      {exec ? (
        <>
          <h2 className="mt-8 text-sm font-semibold text-ink">Executive summary</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Confidence{" "}
            <span className="font-semibold text-ink">
              {Math.round(exec.confidence * 100)}%
            </span>{" "}
            · period {exec.periodDays} days
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard label="Bookings" kpi={exec.bookings} />
            <KpiCard label="Revenue" kpi={exec.revenue} formatter={dollars} />
            <KpiCard label="Cancellations" kpi={exec.cancellations} inverse />
            <KpiCard label="Waitlist conversions" kpi={exec.waitlistConversions} />
            <KpiCard label="Avg booking value" kpi={exec.avgBookingValue} formatter={dollars} />
            <KpiCard label="Repeat customer %" kpi={exec.repeatCustomerPct} suffix="%" />
            <KpiCard label="Staff efficiency" kpi={exec.staffEfficiency} suffix="%" />
          </div>
        </>
      ) : (
        <div className="mt-8 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-500">
          More executive analytics will appear once {2 * 7} days of snapshot history accumulates.
        </div>
      )}

      {/* MULTI-LOCATION + DEPARTMENT — hidden if neither configured. */}
      {(hasLocations || hasDepartments) && (
        <>
          <h2 className="mt-8 text-sm font-semibold text-ink">Multi-location performance</h2>
          {hasLocations && (
            <>
              <h3 className="mt-3 text-xs font-medium text-ink-muted uppercase tracking-wider">Locations</h3>
              <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Location</th>
                      <th className="px-3 py-2">Bookings</th>
                      <th className="px-3 py-2">Completed</th>
                      <th className="px-3 py-2">Cancelled</th>
                      <th className="px-3 py-2">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {locations.map((l) => (
                      <tr key={l.locationId} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-ink">{l.locationName}</td>
                        <td className="px-3 py-2 tabular-nums">{l.bookings}</td>
                        <td className="px-3 py-2 tabular-nums">{l.completed}</td>
                        <td className="px-3 py-2 tabular-nums">{l.cancelled}</td>
                        <td className="px-3 py-2 tabular-nums">{dollars(l.grossRevenueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {hasDepartments && (
            <>
              <h3 className="mt-4 text-xs font-medium text-ink-muted uppercase tracking-wider">Departments</h3>
              <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Department</th>
                      <th className="px-3 py-2">Bookings</th>
                      <th className="px-3 py-2">Completed</th>
                      <th className="px-3 py-2">Cancelled</th>
                      <th className="px-3 py-2">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {departments.map((d) => (
                      <tr key={d.departmentId} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-ink">{d.departmentName}</td>
                        <td className="px-3 py-2 tabular-nums">{d.bookings}</td>
                        <td className="px-3 py-2 tabular-nums">{d.completed}</td>
                        <td className="px-3 py-2 tabular-nums">{d.cancelled}</td>
                        <td className="px-3 py-2 tabular-nums">{dollars(d.grossRevenueCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {/* CUSTOMER INTELLIGENCE — hidden if no bookings in window. */}
      {hasCustomerData && (
        <>
          <h2 className="mt-8 text-sm font-semibold text-ink">Customer intelligence</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Repeat customer %" value={`${customerIntel.repeatCustomerRate}%`} />
            <Stat label="Retention rate" value={`${customerIntel.retentionRate}%`} muted />
            <Stat label="New customers" value={String(customerIntel.newCustomersThisPeriod)} muted />
            <Stat label="From existing" value={String(customerIntel.bookingsByExistingCustomers)} muted />
            <Stat label="From new" value={String(customerIntel.bookingsByNewCustomers)} muted />
          </div>
        </>
      )}

      {/* OPTIMIZATION RECOMMENDATIONS — hidden when none. */}
      {optimizationRecs.length > 0 && (
        <>
          <h2 className="mt-8 text-sm font-semibold text-ink">Optimization recommendations</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Deterministic — each recommendation cites the metrics that triggered it. Sorted by priority.
          </p>
          {CATEGORY_ORDER.filter(([key]) => (recsByCategory[key] ?? []).length > 0).map(
            ([key, label]) => (
              <div key={key} className="mt-4">
                <h3 className="text-xs font-medium uppercase tracking-wider text-ink-muted">
                  {label} <span className="text-ink-subtle">({recsByCategory[key]?.length ?? 0})</span>
                </h3>
                <div className="mt-2 space-y-2">
                  {(recsByCategory[key] ?? []).map((r) => (
                    <RecommendationCard key={r.code} rec={r} />
                  ))}
                </div>
              </div>
            )
          )}
        </>
      )}
    </Shell>
  );
}

function RecommendationCard({
  rec,
}: {
  rec: {
    code: string;
    severity: "low" | "medium" | "high" | "critical";
    title: string;
    explanation: string;
    supportingMetrics: Array<{ label: string; value: string }>;
    confidence: number;
    projectedImpact: { description: string; monthlyImpactCents: number };
  };
}) {
  const sevClass =
    rec.severity === "critical"
      ? "bg-red-100 text-red-800 border-red-200"
      : rec.severity === "high"
        ? "bg-amber-100 text-amber-800 border-amber-200"
        : rec.severity === "medium"
          ? "bg-blue-100 text-blue-800 border-blue-200"
          : "bg-slate-100 text-slate-700 border-slate-200";
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${sevClass}`}>
              {rec.severity}
            </span>
            <h4 className="text-sm font-medium text-ink">{rec.title}</h4>
          </div>
          <p className="mt-1 text-xs text-ink-muted">{rec.explanation}</p>
          {rec.supportingMetrics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-subtle">
              {rec.supportingMetrics.map((m, i) => (
                <span key={i}>
                  <span className="font-medium">{m.label}:</span> {m.value}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="shrink-0 text-right text-[11px] text-ink-subtle">
          <div>conf {Math.round(rec.confidence * 100)}%</div>
          {rec.projectedImpact.monthlyImpactCents > 0 && (
            <div className="mt-0.5 font-semibold text-green-700">
              +${(rec.projectedImpact.monthlyImpactCents / 100).toFixed(0)}/mo
            </div>
          )}
        </div>
      </div>
      {rec.projectedImpact.monthlyImpactCents > 0 && (
        <p className="mt-2 border-t border-slate-100 pt-2 text-[11px] text-ink-subtle">
          {rec.projectedImpact.description}
        </p>
      )}
    </div>
  );
}

function KpiCard({
  label,
  kpi,
  formatter,
  suffix,
  inverse,
}: {
  label: string;
  kpi: {
    comparison: {
      currentValue: number;
      previousValue: number;
      percentChange: number;
      quality: string;
    };
    trendDirection: "up" | "down" | "flat";
  };
  formatter?: (v: number) => string;
  suffix?: string;
  /** When true (cancellations etc.), a DOWN trend is GOOD. Color-flips. */
  inverse?: boolean;
}) {
  const cur = formatter ? formatter(kpi.comparison.currentValue) : `${kpi.comparison.currentValue}${suffix ?? ""}`;
  const prev = formatter ? formatter(kpi.comparison.previousValue) : `${kpi.comparison.previousValue}${suffix ?? ""}`;
  const sign = kpi.comparison.percentChange > 0 ? "+" : "";
  const trendIsGood =
    kpi.trendDirection === "flat"
      ? null
      : inverse
        ? kpi.trendDirection === "down"
        : kpi.trendDirection === "up";
  const trendClass =
    trendIsGood === null
      ? "text-slate-500"
      : trendIsGood
        ? "text-green-700"
        : "text-red-700";

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{label}</div>
      <div className="mt-1 text-base font-semibold text-ink tabular-nums">{cur}</div>
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className="text-ink-subtle">prev {prev}</span>
        <span className={`font-medium ${trendClass}`}>{sign}{kpi.comparison.percentChange}%</span>
      </div>
    </div>
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

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
