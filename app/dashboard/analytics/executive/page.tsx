/**
 * Executive Analytics — Luxury Intelligence Cockpit (Phase 8A).
 *
 * All data fetching + math is preserved verbatim from the original
 * server component. Only the UI rendering layer is rebuilt with the
 * premium primitives shared across the rest of the workspace
 * (PremiumCard, MetricCard, InsightCard, FadeIn, zm-border-sweep,
 * zm-light-sweep, zm-pulse-glow). No backend / API / route changes.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import {
  Sparkles,
  Activity,
  Users,
  CalendarRange,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  Building2,
  Layers,
  AlertTriangle,
  Lightbulb,
  Download,
  Crown,
  type LucideIcon,
} from "lucide-react";

import { db } from "@/db/client";
import { analyticsDailySnapshots, tenants, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import Shell from "@/components/dashboard/Shell";
import { PremiumCard, MetricCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";
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
import { effectivePermissions } from "@/lib/security/permissions";
import type { DailyAggregate, SnapshotExtras } from "@/lib/analytics/types";

export const metadata = { title: "Executive analytics" };
export const dynamic = "force-dynamic";

const WINDOW_DAYS = 60;

export default async function ExecutiveAnalyticsPage() {
  const session = await getSession();
  if (!session) redirect("/dashboard/login");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) redirect("/dashboard/login");
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) redirect("/dashboard");

  const permissions = effectivePermissions(user);
  const shellProps = {
    user: { name: user.name, email: user.email, role: user.role, permissions },
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
        <UpgradePrompt />
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
      <div className="relative mt-2 space-y-5">
        {/* Ambient background depth */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 top-32 -z-10 h-80 w-80 rounded-full bg-brand-accent/[0.05] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-32 top-96 -z-10 h-72 w-72 rounded-full bg-brand-accent/[0.04] blur-3xl"
        />

        {/* Hero */}
        <FadeIn>
          <ExecutiveHero
            confidence={exec?.confidence ?? 0}
            periodDays={exec?.periodDays ?? halfDays}
            canExport={permissions.canExportReports}
            window={WINDOW_DAYS}
          />
        </FadeIn>

        {/* AI Intelligence Strip */}
        {exec && (
          <FadeIn delay={1}>
            <AIIntelligenceStrip exec={exec} customerIntel={hasCustomerData ? customerIntel : null} />
          </FadeIn>
        )}

        {!exec && (
          <FadeIn delay={1}>
            <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/30 via-surface to-surface">
              <div className="flex items-start gap-3 px-2 py-4">
                <div className="zm-pulse-glow inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
                  <Activity className="h-5 w-5" strokeWidth={1.75} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[14px] font-semibold tracking-tight text-ink">Building your executive view</h3>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
                    Executive intelligence will surface once {2 * 7} days of snapshot history accumulates. Your daily aggregation is already running.
                  </p>
                </div>
              </div>
            </PremiumCard>
          </FadeIn>
        )}

        {/* KPI grid */}
        {exec && (
          <FadeIn delay={2}>
            <div>
              <SectionHead
                eyebrow="Operational health"
                title="Executive KPIs"
                description={`Comparing the last ${halfDays} days against the prior ${halfDays}.`}
              />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <LuxKpi label="Bookings" kpi={exec.bookings} icon={CalendarRange} tone="brand" />
                <LuxKpi label="Revenue" kpi={exec.revenue} formatter={dollars} icon={TrendingUp} tone="positive" />
                <LuxKpi label="Cancellations" kpi={exec.cancellations} icon={TrendingDown} tone="warning" inverse />
                <LuxKpi label="Waitlist conversions" kpi={exec.waitlistConversions} icon={Activity} tone="brand" />
                <LuxKpi label="Avg booking value" kpi={exec.avgBookingValue} formatter={dollars} icon={TrendingUp} tone="positive" />
                <LuxKpi label="Repeat customer %" kpi={exec.repeatCustomerPct} suffix="%" icon={Users} tone="positive" />
                <LuxKpi label="Staff efficiency" kpi={exec.staffEfficiency} suffix="%" icon={Activity} tone="brand" />
              </div>
            </div>
          </FadeIn>
        )}

        {/* AI insight cards — derived from exec deltas */}
        {exec && (
          <FadeIn delay={3}>
            <PredictiveInsights exec={exec} customerIntel={hasCustomerData ? customerIntel : null} />
          </FadeIn>
        )}

        {/* Multi-location + Department */}
        {(hasLocations || hasDepartments) && (
          <FadeIn delay={4}>
            <div className="space-y-4">
              <SectionHead
                eyebrow="Distribution"
                title="Multi-location performance"
                description="Booking and revenue distribution across your operational footprint."
              />
              {hasLocations && (
                <PerfTable
                  icon={Building2}
                  heading="Locations"
                  rows={locations.map((l) => ({
                    name: l.locationName,
                    bookings: l.bookings,
                    completed: l.completed,
                    cancelled: l.cancelled,
                    revenueCents: l.grossRevenueCents,
                  }))}
                />
              )}
              {hasDepartments && (
                <PerfTable
                  icon={Layers}
                  heading="Departments"
                  rows={departments.map((d) => ({
                    name: d.departmentName,
                    bookings: d.bookings,
                    completed: d.completed,
                    cancelled: d.cancelled,
                    revenueCents: d.grossRevenueCents,
                  }))}
                />
              )}
            </div>
          </FadeIn>
        )}

        {/* Customer intelligence */}
        {hasCustomerData && (
          <FadeIn delay={5}>
            <div>
              <SectionHead
                eyebrow="Customer intelligence"
                title="Relationship signal"
                description="Repeat behavior and retention quality across the current window."
              />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <MetricCard label="Repeat customer" value={`${customerIntel.repeatCustomerRate}%`} icon={Crown} tone="positive" />
                <MetricCard label="Retention" value={`${customerIntel.retentionRate}%`} icon={Users} tone="brand" />
                <MetricCard label="New customers" value={String(customerIntel.newCustomersThisPeriod)} icon={Sparkles} tone="brand" />
                <MetricCard label="From existing" value={String(customerIntel.bookingsByExistingCustomers)} icon={Activity} tone="neutral" />
                <MetricCard label="From new" value={String(customerIntel.bookingsByNewCustomers)} icon={Activity} tone="neutral" />
              </div>
            </div>
          </FadeIn>
        )}

        {/* Optimization recommendations */}
        {optimizationRecs.length > 0 && (
          <FadeIn delay={6}>
            <div className="space-y-4">
              <SectionHead
                eyebrow="Optimization"
                title="Recommendations"
                description="Deterministic — each recommendation cites the metrics that triggered it. Sorted by severity."
              />
              {CATEGORY_ORDER.filter(([key]) => (recsByCategory[key] ?? []).length > 0).map(
                ([key, label]) => (
                  <div key={key}>
                    <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand-accent" />
                      {label}
                      <span className="text-ink-subtle">({recsByCategory[key]?.length ?? 0})</span>
                    </h3>
                    <div className="space-y-2">
                      {(recsByCategory[key] ?? []).map((r) => (
                        <LuxRecommendation key={r.code} rec={r} />
                      ))}
                    </div>
                  </div>
                )
              )}
            </div>
          </FadeIn>
        )}
      </div>
    </Shell>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────

function ExecutiveHero({
  confidence,
  periodDays,
  canExport,
  window,
}: {
  confidence: number;
  periodDays: number;
  canExport: boolean;
  window: number;
}) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/45 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-accent/12 blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
            <Sparkles className="h-3 w-3" strokeWidth={2} />
            Executive intelligence cockpit
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Executive analytics
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Operational intelligence across bookings, customers, staffing, and revenue.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {confidence > 0 && (
            <span className="zm-pulse-glow inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
              <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
              Confidence · {Math.round(confidence * 100)}%
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-muted backdrop-blur-sm">
            {periodDays}d period
          </span>
          {canExport && (
            <a
              href={`/api/tenant/analytics/executive/export?range=${window}`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
              Export CSV
            </a>
          )}
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── AI strip ──────────────────────────────────────────────────────

function AIIntelligenceStrip({
  exec,
  customerIntel,
}: {
  exec: NonNullable<ReturnType<typeof buildExecutiveSummary>>;
  customerIntel: Awaited<ReturnType<typeof aggregateCustomerIntelligence>> | null;
}) {
  const signal = deriveExecutiveSignal(exec, customerIntel);
  return (
    <div className="zm-border-sweep relative overflow-hidden rounded-2xl">
      <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/45 via-surface to-surface shadow-soft">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
        <span
          aria-hidden
          className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent"
        />
        <div className="relative flex items-center gap-3 px-4 py-3 sm:px-5">
          <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
            <Sparkles className="h-4 w-4" strokeWidth={2} />
            <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)] ring-2 ring-surface" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Operational signal
            </div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-ink">{signal}</div>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface/70 px-2 py-0.5 text-[10px] font-medium text-ink-muted backdrop-blur-sm sm:inline-flex">
            <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            Live
          </div>
        </div>
      </div>
    </div>
  );
}

function deriveExecutiveSignal(
  exec: NonNullable<ReturnType<typeof buildExecutiveSummary>>,
  customerIntel: Awaited<ReturnType<typeof aggregateCustomerIntelligence>> | null,
): string {
  const bookingPct = exec.bookings.comparison.percentChange;
  const cancelPct = exec.cancellations.comparison.percentChange;
  const revenuePct = exec.revenue.comparison.percentChange;
  if (bookingPct >= 15 && revenuePct >= 10) {
    return `Booking momentum is strong — bookings up ${bookingPct}% and revenue up ${revenuePct}%. Capacity health remains balanced.`;
  }
  if (cancelPct >= 20) {
    return `Cancellation rate climbed ${cancelPct}%. Recommend tightening reminder cadence and reviewing no-show prevention.`;
  }
  if (customerIntel && customerIntel.retentionRate >= 60) {
    return `Customer retention at ${customerIntel.retentionRate}% — relationship layer is healthy. Lean into VIP engagement.`;
  }
  if (revenuePct >= 5) {
    return `Revenue trend up ${revenuePct}%. Operations remain calm; capacity is sustainable through the period.`;
  }
  if (Math.abs(bookingPct) < 5 && Math.abs(revenuePct) < 5) {
    return "Operational load remains balanced this week. No urgent intervention needed.";
  }
  if (bookingPct <= -10) {
    return `Booking volume softened ${Math.abs(bookingPct)}%. A short outreach window or promotion may rebalance demand.`;
  }
  return "Operational signals are within expected ranges. Capacity, retention, and delivery remain steady.";
}

// ─── Predictive AI insight cards ───────────────────────────────────

function PredictiveInsights({
  exec,
  customerIntel,
}: {
  exec: NonNullable<ReturnType<typeof buildExecutiveSummary>>;
  customerIntel: Awaited<ReturnType<typeof aggregateCustomerIntelligence>> | null;
}) {
  const insights = derivePredictiveInsights(exec, customerIntel);
  if (insights.length === 0) return null;
  return (
    <div>
      <SectionHead
        eyebrow="AI insight"
        title="Operational observations"
        description="Pattern-based observations derived from your trailing 60-day window. Each card cites its supporting metric."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {insights.map((i, idx) => (
          <InsightTile key={idx} insight={i} />
        ))}
      </div>
    </div>
  );
}

type Insight = {
  title: string;
  body: string;
  supporting: string;
  tone: "positive" | "warning" | "brand";
  confidence: "high" | "medium" | "low";
};

function derivePredictiveInsights(
  exec: NonNullable<ReturnType<typeof buildExecutiveSummary>>,
  customerIntel: Awaited<ReturnType<typeof aggregateCustomerIntelligence>> | null,
): Insight[] {
  const out: Insight[] = [];
  const bookingPct = exec.bookings.comparison.percentChange;
  const cancelPct = exec.cancellations.comparison.percentChange;
  const revenuePct = exec.revenue.comparison.percentChange;
  const repeatPct = exec.repeatCustomerPct.comparison.percentChange;
  const staffPct = exec.staffEfficiency.comparison.percentChange;
  const wlPct = exec.waitlistConversions.comparison.percentChange;

  if (repeatPct >= 5) {
    out.push({
      title: "Repeat customers strengthening",
      body: `Repeat customer rate up ${repeatPct}% vs prior window. Relationship layer is compounding.`,
      supporting: `Now ${exec.repeatCustomerPct.comparison.currentValue}% (was ${exec.repeatCustomerPct.comparison.previousValue}%)`,
      tone: "positive",
      confidence: "high",
    });
  } else if (repeatPct <= -5) {
    out.push({
      title: "Repeat behavior cooling",
      body: `Repeat customer rate dropped ${Math.abs(repeatPct)}%. A re-engagement campaign typically recovers ~half within 30 days.`,
      supporting: `Now ${exec.repeatCustomerPct.comparison.currentValue}% (was ${exec.repeatCustomerPct.comparison.previousValue}%)`,
      tone: "warning",
      confidence: "medium",
    });
  }

  if (bookingPct >= 10) {
    out.push({
      title: "Booking momentum accelerating",
      body: `Bookings up ${bookingPct}%. Watch staff load — efficiency at ${exec.staffEfficiency.comparison.currentValue}%.`,
      supporting: `Now ${exec.bookings.comparison.currentValue} (was ${exec.bookings.comparison.previousValue})`,
      tone: "positive",
      confidence: "high",
    });
  } else if (bookingPct <= -10) {
    out.push({
      title: "Booking demand softening",
      body: `Bookings down ${Math.abs(bookingPct)}%. Consider a short outreach to dormant customers or temporary slot promotions.`,
      supporting: `Now ${exec.bookings.comparison.currentValue} (was ${exec.bookings.comparison.previousValue})`,
      tone: "warning",
      confidence: "medium",
    });
  }

  if (cancelPct >= 15) {
    out.push({
      title: "Cancellations rising",
      body: `Cancellation rate up ${cancelPct}%. Reminder cadence + a short pre-call typically recovers ~30%.`,
      supporting: `Now ${exec.cancellations.comparison.currentValue} (was ${exec.cancellations.comparison.previousValue})`,
      tone: "warning",
      confidence: "medium",
    });
  }

  if (wlPct >= 20) {
    out.push({
      title: "Waitlist converting well",
      body: `Waitlist conversions up ${wlPct}%. Demand exceeds standard capacity — consider opening secondary slots.`,
      supporting: `Now ${exec.waitlistConversions.comparison.currentValue} (was ${exec.waitlistConversions.comparison.previousValue})`,
      tone: "brand",
      confidence: "medium",
    });
  }

  if (staffPct <= -10) {
    out.push({
      title: "Staff efficiency dropping",
      body: `Efficiency down ${Math.abs(staffPct)}%. Likely indicates uneven load distribution — review staff routing rules.`,
      supporting: `Now ${exec.staffEfficiency.comparison.currentValue}% (was ${exec.staffEfficiency.comparison.previousValue}%)`,
      tone: "warning",
      confidence: "medium",
    });
  }

  if (revenuePct >= 10) {
    out.push({
      title: "Revenue trajectory healthy",
      body: `Revenue up ${revenuePct}% vs prior window. Average booking value at ${dollars(exec.avgBookingValue.comparison.currentValue)}.`,
      supporting: `Now ${dollars(exec.revenue.comparison.currentValue)} (was ${dollars(exec.revenue.comparison.previousValue)})`,
      tone: "positive",
      confidence: "high",
    });
  }

  if (customerIntel && customerIntel.retentionRate >= 70 && out.length < 6) {
    out.push({
      title: "Customer base highly loyal",
      body: `${customerIntel.retentionRate}% of last-period customers booked again. Lean into VIP and referral programs.`,
      supporting: `${customerIntel.bookingsByExistingCustomers} bookings from existing customers this window`,
      tone: "positive",
      confidence: "high",
    });
  }

  return out.slice(0, 6);
}

function InsightTile({ insight }: { insight: Insight }) {
  const ring =
    insight.tone === "positive" ? "ring-emerald-200/50 bg-emerald-50/30"
    : insight.tone === "warning"  ? "ring-amber-200/50 bg-amber-50/30"
    :                                "ring-brand-accent/15 bg-brand-subtle/30";
  const iconTone =
    insight.tone === "positive" ? "bg-emerald-50 text-emerald-700"
    : insight.tone === "warning"  ? "bg-amber-50 text-amber-700"
    :                                "bg-brand-subtle text-brand-accent";
  return (
    <div className={cn(
      "relative overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] ring-1",
      ring,
      "hover:-translate-y-0.5 hover:shadow-lift",
    )}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
      />
      <div className="flex items-start gap-3">
        <div className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-border/40", iconTone)}>
          <Lightbulb className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
              AI insight
            </span>
            <ConfidenceChip level={insight.confidence} />
          </div>
          <h4 className="mt-0.5 text-[13px] font-semibold tracking-tight text-ink">{insight.title}</h4>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{insight.body}</p>
          <p className="mt-2 text-[10px] font-medium text-ink-subtle">
            <span className="uppercase tracking-wider">Supporting · </span>
            {insight.supporting}
          </p>
        </div>
      </div>
    </div>
  );
}

function ConfidenceChip({ level }: { level: "high" | "medium" | "low" }) {
  const map = {
    high:   { label: "High",   cls: "bg-emerald-50/80 text-emerald-700 ring-1 ring-emerald-200/40", dot: "bg-emerald-500" },
    medium: { label: "Medium", cls: "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15", dot: "bg-brand-accent" },
    low:    { label: "Low",    cls: "bg-surface-inset text-ink-subtle ring-1 ring-border/40",          dot: "bg-ink-subtle/50" },
  } as const;
  const m = map[level];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]", m.cls)}>
      <span aria-hidden className={cn("inline-block h-1 w-1 rounded-full", m.dot)} />
      Confidence · {m.label}
    </span>
  );
}

// ─── Lux KPI card ─────────────────────────────────────────────────

function LuxKpi({
  label,
  kpi,
  formatter,
  suffix,
  inverse,
  icon: Icon,
  tone,
}: {
  label: string;
  kpi: {
    comparison: { currentValue: number; previousValue: number; percentChange: number; quality: string };
    trendDirection: "up" | "down" | "flat";
  };
  formatter?: (v: number) => string;
  suffix?: string;
  inverse?: boolean;
  icon: LucideIcon;
  tone: "brand" | "positive" | "warning" | "neutral";
}) {
  const cur = formatter ? formatter(kpi.comparison.currentValue) : `${kpi.comparison.currentValue}${suffix ?? ""}`;
  const prev = formatter ? formatter(kpi.comparison.previousValue) : `${kpi.comparison.previousValue}${suffix ?? ""}`;
  const sign = kpi.comparison.percentChange > 0 ? "+" : "";
  // inverse means "lower-is-better" (e.g. cancellations). We don't currently
  // remap MetricCard tone based on this — MetricCard handles its own visual
  // dimming based on `tone`. Keeping the prop for future remap if needed.
  void inverse;

  return (
    <MetricCard
      label={label}
      value={cur}
      icon={Icon}
      tone={tone}
      trend={{
        direction: kpi.trendDirection,
        label: `${sign}${kpi.comparison.percentChange}% vs prev`,
      }}
      sparkline={
        <div className="text-right text-[10px] font-medium tabular-nums text-ink-subtle">
          prev <span className="text-ink-muted">{prev}</span>
        </div>
      }
    />
  );
}

// ─── Performance card table ───────────────────────────────────────

function PerfTable({
  icon: Icon,
  heading,
  rows,
}: {
  icon: LucideIcon;
  heading: string;
  rows: Array<{ name: string; bookings: number; completed: number; cancelled: number; revenueCents: number }>;
}) {
  return (
    <PremiumCard compact interactive={false} className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface-inset text-ink-muted">
            <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {heading}
          </span>
        </div>
        <span className="text-[10px] tabular-nums text-ink-subtle">{rows.length}</span>
      </div>
      <ul className="divide-y divide-border/40">
        {rows.map((r, i) => (
          <li key={i} className="grid grid-cols-[1fr_repeat(4,minmax(0,80px))] items-center gap-2 px-4 py-2.5 text-[12px] transition-colors hover:bg-surface-inset/30 sm:grid-cols-[1fr_repeat(4,minmax(0,100px))]">
            <div className="min-w-0 truncate font-medium text-ink">{r.name}</div>
            <div className="text-right tabular-nums text-ink">{r.bookings}</div>
            <div className="text-right tabular-nums text-emerald-700">{r.completed}</div>
            <div className="text-right tabular-nums text-ink-muted">{r.cancelled}</div>
            <div className="text-right font-semibold tabular-nums text-ink">{dollars(r.revenueCents)}</div>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-[1fr_repeat(4,minmax(0,80px))] gap-2 border-t border-border/40 bg-surface-subtle/40 px-4 py-1.5 text-[9px] font-semibold uppercase tracking-wider text-ink-subtle sm:grid-cols-[1fr_repeat(4,minmax(0,100px))]">
        <span>Name</span>
        <span className="text-right">Bookings</span>
        <span className="text-right">Completed</span>
        <span className="text-right">Cancelled</span>
        <span className="text-right">Revenue</span>
      </div>
    </PremiumCard>
  );
}

// ─── Luxury recommendation card ───────────────────────────────────

function LuxRecommendation({
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
  const sev = rec.severity;
  const rail =
    sev === "critical" ? "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.45)]"
    : sev === "high"     ? "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.35)]"
    : sev === "medium"   ? "bg-brand-accent shadow-[0_0_8px_rgba(53,157,243,0.35)]"
    :                       "bg-slate-300";
  const sevChip =
    sev === "critical" ? "bg-red-50/80 text-red-700 ring-1 ring-red-200/40"
    : sev === "high"     ? "bg-amber-50/80 text-amber-800 ring-1 ring-amber-200/40"
    : sev === "medium"   ? "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15"
    :                       "bg-surface-inset text-ink-muted ring-1 ring-border/40";

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-surface p-3.5 shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:scale-[1.002] hover:border-border-strong hover:shadow-lift">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1 rounded-l-2xl", rail)} />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100"
        style={{ boxShadow: "0 0 0 1px rgba(53,157,243,0.18), 0 10px 28px rgba(53,157,243,0.10)" }}
      />
      <div className="relative flex items-start gap-3 pl-2">
        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-inset text-ink-muted ring-1 ring-border/40">
          {sev === "critical" || sev === "high"
            ? <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
            : <Lightbulb className="h-4 w-4" strokeWidth={1.75} />
          }
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]", sevChip)}>
              <span aria-hidden className={cn("inline-block h-1 w-1 rounded-full", rail.split(" ")[0])} />
              {sev}
            </span>
            <h4 className="truncate text-[13px] font-semibold tracking-tight text-ink">{rec.title}</h4>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{rec.explanation}</p>
          {rec.supportingMetrics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-ink-subtle">
              {rec.supportingMetrics.map((m, i) => (
                <span key={i}>
                  <span className="font-semibold text-ink-muted">{m.label}:</span> {m.value}
                </span>
              ))}
            </div>
          )}
          {rec.projectedImpact.monthlyImpactCents > 0 && (
            <p className="mt-2 border-t border-border/40 pt-2 text-[10px] text-ink-subtle">
              {rec.projectedImpact.description}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right text-[10px]">
          <div className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 font-medium uppercase tracking-wider text-ink-muted">
            Conf · {Math.round(rec.confidence * 100)}%
          </div>
          {rec.projectedImpact.monthlyImpactCents > 0 && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-50/80 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200/40">
              +${(rec.projectedImpact.monthlyImpactCents / 100).toFixed(0)}/mo
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────

function SectionHead({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <header className="mb-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
        {eyebrow}
      </div>
      <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      {description && (
        <p className="mt-0.5 text-[12px] text-ink-muted">{description}</p>
      )}
    </header>
  );
}

// ─── Upgrade prompt ───────────────────────────────────────────────

function UpgradePrompt() {
  return (
    <div className="mt-6">
      <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-amber-50/40 via-surface to-surface">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-amber-200/30 blur-3xl"
        />
        <div className="relative flex items-start gap-3 p-2">
          <div className="zm-pulse-glow inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-amber-200/40 bg-gradient-to-br from-amber-50 to-surface text-amber-700 shadow-soft">
            <Crown className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-700">
              Pro feature
            </div>
            <h2 className="mt-0.5 text-[18px] font-semibold tracking-tight text-ink">
              Executive analytics
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
              Unlock executive KPIs, predictive insights, multi-location performance, and optimization recommendations.
            </p>
            <Link
              href="/dashboard/billing"
              className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              Upgrade plan
              <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
            </Link>
          </div>
        </div>
      </PremiumCard>
    </div>
  );
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
