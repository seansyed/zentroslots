/**
 * Executive Analytics — Luxury Intelligence Cockpit (Phase 8B).
 *
 * Phase 8A delivered the premium intelligence cockpit. Phase 8B
 * evolves it into an executive narrative system:
 *
 *   - DailyOperationalBrief (flagship)
 *   - ExecutiveNarrative (cross-metric storytelling)
 *   - TodayRhythmStrip (today's operational pulse)
 *   - PredictiveInsights with 5-level priority hierarchy
 *   - Humanized confidence language
 *   - LuxRecommendation with effort × impact + outcome line
 *   - Deeper atmospheric hero
 *
 * All data fetching, math, query shapes, and plan gates are preserved
 * verbatim. No backend / API / route / auth changes.
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import {
  Sparkles,
  Activity,
  Users,
  CalendarRange,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  ArrowUpRight,
  Building2,
  Layers,
  AlertTriangle,
  Lightbulb,
  Download,
  Crown,
  Sun,
  CheckCircle2,
  CircleDot,
  Gauge,
  Bell,
  Workflow,
  Compass,
  Telescope,
  Target,
  ShieldAlert,
  Wand2,
  Lock,
  DollarSign,
  Zap,
  LineChart,
  Eye,
  Clock,
  Mail,
  ServerCog,
  Shield,
  FileText,
  Flame,
  Megaphone,
  CircleAlert,
  PartyPopper,
  type LucideIcon,
} from "lucide-react";

import { db } from "@/db/client";
import {
  analyticsDailySnapshots,
  calendarConnections,
  calendarSyncLogs,
  scheduledReports,
  tenants,
  users,
} from "@/db/schema";
import { getSession } from "@/lib/auth";
import { planFeature } from "@/lib/quotas";
import { getPlan } from "@/lib/plans";
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

// ─── Types shared by the UI helpers ──────────────────────────────────

type ExecSummary = NonNullable<ReturnType<typeof buildExecutiveSummary>>;
type CustomerIntel = Awaited<ReturnType<typeof aggregateCustomerIntelligence>>;

type Confidence = "strong" | "moderate" | "early" | "monitoring";
type Priority = "opportunity" | "momentum" | "warning" | "critical" | "optimization";

type Insight = {
  title: string;
  body: string;
  supporting: string;
  priority: Priority;
  confidence: Confidence;
};

type BriefObservation = {
  label: string;
  value: string;
  tone: "positive" | "warning" | "neutral" | "brand";
};

type DailyBrief = {
  headline: string;
  observations: BriefObservation[];
  focus: string;
  confidence: Confidence;
  tone: "positive" | "warning" | "brand";
};

type RhythmTile = {
  label: string;
  value: string;
  detail: string;
  signal: "calm" | "watch" | "alert";
  icon: LucideIcon;
};

// Phase 12B — Operational Health Strip
type HealthStatus = "healthy" | "warning" | "degraded" | "critical" | "idle";

type HealthTileData = {
  label: string;
  status: HealthStatus;
  primary: string;       // headline (e.g. "100% delivered")
  detail: string;        // sub line (e.g. "Last 24h · 142 sent · 0 failed")
  icon: LucideIcon;
};

// Phase 12B — Executive activity timeline
type TimelineKind =
  | "revenue_milestone"
  | "booking_spike"
  | "cancel_spike"
  | "waitlist_conversion"
  | "review_burst"
  | "calm_window";

type TimelineEntry = {
  kind: TimelineKind;
  dateLabel: string;     // "Tue, May 14"
  headline: string;
  detail: string;
  tone: "positive" | "warning" | "neutral" | "brand";
  icon: LucideIcon;
};

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
        <LockedExecutivePreview
          currentPlanName={getPlan(tenant.currentPlan).name}
        />
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

  // ── Phase 12B · Operational health inputs ─────────────────────────
  // Cheap aggregate queries that surface the four health pillars:
  //   1) Calendar sync — count of connections by status + last-24h
  //      success-rate from calendar_sync_logs
  //   2) Reminder delivery — derived from snapshot sent/suppressed
  //   3) Booking ingestion — does today's snapshot row exist?
  //   4) Scheduled reports — last generated row freshness
  //
  // All wrapped in a try/catch — if any health query errors (e.g.
  // missing table on an old tenant DB), the strip silently hides and
  // the rest of the cockpit keeps rendering. No fake health values.
  const last24h = new Date(today.getTime() - 24 * 60 * 60_000);

  const [connectionStatusRows, syncLogStatusRows, lastReportRow] = await Promise.all([
    db
      .select({
        status: calendarConnections.status,
        n: sql<number>`count(*)::int`,
      })
      .from(calendarConnections)
      .where(eq(calendarConnections.tenantId, user.tenantId))
      .groupBy(calendarConnections.status)
      .catch(() => [] as Array<{ status: string; n: number }>),
    db
      .select({
        status: calendarSyncLogs.status,
        n: sql<number>`count(*)::int`,
      })
      .from(calendarSyncLogs)
      .where(
        and(
          eq(calendarSyncLogs.tenantId, user.tenantId),
          gte(calendarSyncLogs.createdAt, last24h)
        )
      )
      .groupBy(calendarSyncLogs.status)
      .catch(() => [] as Array<{ status: string; n: number }>),
    db
      .select({
        periodType: scheduledReports.periodType,
        generatedAt: scheduledReports.generatedAt,
      })
      .from(scheduledReports)
      .where(eq(scheduledReports.tenantId, user.tenantId))
      .orderBy(desc(scheduledReports.generatedAt))
      .limit(1)
      .catch(() => [] as Array<{ periodType: string; generatedAt: Date }>),
  ]);

  const operationalHealth = deriveOperationalHealth({
    today,
    snapshots,
    connectionStatusRows,
    syncLogStatusRows,
    lastReport: lastReportRow[0] ?? null,
  });

  // ── Phase 12B · Executive activity timeline ───────────────────────
  // Pure derivation from `snapshots` — no extra query. Surfaces 5–8
  // notable operational events from the trailing window.
  const timelineEntries = deriveExecutiveTimeline(snapshots);

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

  const dayLabel = today.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <Shell {...shellProps}>
      <div className="relative mt-2 space-y-5">
        {/* Ambient background depth */}
        <div
          aria-hidden
          className="pointer-events-none absolute -left-32 top-24 -z-10 h-[28rem] w-[28rem] rounded-full bg-brand-accent/[0.06] blur-[120px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 top-80 -z-10 h-[24rem] w-[24rem] rounded-full bg-emerald-300/[0.05] blur-[120px]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[60rem] -z-10 h-[20rem] w-[20rem] -translate-x-1/2 rounded-full bg-amber-200/[0.04] blur-[120px]"
        />

        {/* Hero */}
        <FadeIn>
          <ExecutiveHero
            confidence={exec?.confidence ?? 0}
            periodDays={exec?.periodDays ?? halfDays}
            canExport={permissions.canExportReports}
            window={WINDOW_DAYS}
            dayLabel={dayLabel}
            tenantName={tenant.name}
          />
        </FadeIn>

        {/* Daily Operational Brief — the flagship */}
        {exec && (
          <FadeIn delay={1}>
            <DailyOperationalBrief
              brief={deriveDailyBrief(exec, hasCustomerData ? customerIntel : null, snapshots)}
              dayLabel={dayLabel}
            />
          </FadeIn>
        )}

        {/* Executive Narrative — cross-metric story */}
        {exec && (
          <FadeIn delay={2}>
            <ExecutiveNarrative
              paragraphs={deriveExecutiveNarrative(exec, hasCustomerData ? customerIntel : null)}
            />
          </FadeIn>
        )}

        {/* Today rhythm */}
        {exec && (
          <FadeIn delay={3}>
            <TodayRhythmStrip
              tiles={deriveTodayRhythm(exec, hasCustomerData ? customerIntel : null, snapshots)}
            />
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
          <FadeIn delay={4}>
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

              {/* Phase 12B — Financial impact strip. All three tiles
                  draw from the same trailing window as the KPI grid,
                  but they express the dollars that operational drift
                  is costing (or that good momentum is projecting).
                  All values are derived from existing snapshot data —
                  no fabricated metrics. The tiles render in a single
                  row that wraps cleanly on mobile. */}
              <FinancialImpactStrip
                cancelImpactCents={
                  exec.cancellations.comparison.currentValue *
                  exec.avgBookingValue.comparison.currentValue
                }
                cancelTrendPct={exec.cancellations.comparison.percentChange}
                noShowImpactCents={(() => {
                  // No-show isn't a top-level exec KPI — derive it
                  // from the snapshot sum × avg booking value.
                  const noShows = snapshots
                    .slice(-halfDays)
                    .reduce((s, r) => s + (r.noShowBookings ?? 0), 0);
                  return noShows * exec.avgBookingValue.comparison.currentValue;
                })()}
                noShowCount={snapshots
                  .slice(-halfDays)
                  .reduce((s, r) => s + (r.noShowBookings ?? 0), 0)}
                forecastedRevenueCents={(() => {
                  // Prefer the precomputed forecasting result from
                  // the latest snapshot's `extras.forecasting` block
                  // (recomputed nightly). Fall back to a trailing-30
                  // projection if the forecaster hasn't run yet.
                  const latest = snapshots[snapshots.length - 1];
                  const projected =
                    latest?.extras?.forecasting?.projectedRevenueNext30Days;
                  if (typeof projected === "number" && projected > 0) {
                    return projected;
                  }
                  const trailing30Sum = snapshots
                    .slice(-30)
                    .reduce(
                      (s, r) =>
                        s + (r.extras?.revenue?.grossRevenueCents ?? 0),
                      0,
                    );
                  return trailing30Sum;
                })()}
                forecastConfidence={
                  snapshots[snapshots.length - 1]?.extras?.forecasting
                    ?.confidenceScore ?? 0
                }
                forecastTrend={
                  snapshots[snapshots.length - 1]?.extras?.forecasting
                    ?.trendDirection ?? "flat"
                }
              />
            </div>
          </FadeIn>
        )}

        {/* Predictive insights with priority hierarchy */}
        {exec && (
          <FadeIn delay={5}>
            <PredictiveInsights exec={exec} customerIntel={hasCustomerData ? customerIntel : null} />
          </FadeIn>
        )}

        {/* Phase 12B — Operational health strip. Renders only when
            at least one health tile has a non-idle signal — keeps
            brand-new tenants (no data anywhere) from seeing a row
            full of grey "idle" tiles. */}
        {operationalHealth.some((t) => t.status !== "idle") && (
          <FadeIn delay={6}>
            <OperationalHealthStrip tiles={operationalHealth} />
          </FadeIn>
        )}

        {/* Multi-location + Department */}
        {(hasLocations || hasDepartments) && (
          <FadeIn delay={7}>
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
          <FadeIn delay={8}>
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

        {/* Phase 12B — Executive activity timeline. Surfaces 5–8
            notable operational events from the trailing window:
            best booking day, biggest cancellation spike, first
            waitlist conversion, etc. Pure derivation from snapshots
            already in memory — no extra query. */}
        {timelineEntries.length > 0 && (
          <FadeIn delay={9}>
            <ExecutiveTimeline entries={timelineEntries} />
          </FadeIn>
        )}

        {/* Optimization recommendations */}
        {optimizationRecs.length > 0 && (
          <FadeIn delay={10}>
            <div className="space-y-4">
              <SectionHead
                eyebrow="Strategic recommendations"
                title="What to do next"
                description="Each recommendation cites the metric that triggered it, scored by effort, impact, and likely outcome."
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
  dayLabel,
  tenantName,
}: {
  confidence: number;
  periodDays: number;
  canExport: boolean;
  window: number;
  dayLabel: string;
  tenantName: string;
}) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      {/* Layered atmospheric depth */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/[0.14] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.18] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-1/4 top-1/2 h-32 w-32 rounded-full bg-amber-100/40 blur-2xl"
      />
      {/* Topology — extremely subtle radial wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "radial-gradient(800px 220px at 80% 0%, rgba(37,99,235,0.06), transparent 70%), radial-gradient(600px 200px at 0% 100%, rgba(16,185,129,0.05), transparent 70%)",
        }}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />
      <span
        aria-hidden
        className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            <Sparkles className="h-3 w-3" strokeWidth={2} />
            Executive intelligence cockpit
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Executive analytics
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            <span className="font-medium text-ink">{tenantName}</span> &middot; {dayLabel} &middot; operational
            intelligence across bookings, customers, staffing, and revenue.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {confidence > 0 && (
            <span className="zm-pulse-glow inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_12px_rgba(37,99,235,0.35)]">
              <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
              {humanConfidence(numericToConfidence(confidence))}
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

// ─── Daily Operational Brief (flagship) ────────────────────────────

function DailyOperationalBrief({
  brief,
  dayLabel,
}: {
  brief: DailyBrief;
  dayLabel: string;
}) {
  const toneFrame =
    brief.tone === "positive"
      ? "from-emerald-50/60 via-surface to-surface ring-emerald-200/40"
      : brief.tone === "warning"
        ? "from-amber-50/60 via-surface to-surface ring-amber-200/40"
        : "from-brand-subtle/55 via-surface to-surface ring-brand-accent/20";
  const haloA =
    brief.tone === "positive"
      ? "bg-emerald-300/[0.18]"
      : brief.tone === "warning"
        ? "bg-amber-300/[0.18]"
        : "bg-brand-accent/[0.18]";
  const haloB =
    brief.tone === "positive"
      ? "bg-emerald-200/[0.12]"
      : brief.tone === "warning"
        ? "bg-amber-200/[0.12]"
        : "bg-brand-accent/[0.12]";

  return (
    <div className={cn(
      "zm-border-sweep relative overflow-hidden rounded-3xl ring-1",
      toneFrame.split(" ").slice(-1)[0]
    )}>
      <div className={cn(
        "relative overflow-hidden rounded-3xl border border-border bg-gradient-to-br shadow-soft",
        toneFrame
      )}>
        {/* Cinematic glow fields */}
        <div aria-hidden className={cn("pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl", haloA)} />
        <div aria-hidden className={cn("pointer-events-none absolute -left-16 -bottom-16 h-52 w-52 rounded-full blur-3xl", haloB)} />
        {/* Subtle topology */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.40]"
          style={{
            backgroundImage:
              "radial-gradient(700px 200px at 70% 10%, rgba(37,99,235,0.06), transparent 70%), radial-gradient(500px 180px at 10% 90%, rgba(16,185,129,0.05), transparent 70%)",
          }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
        />
        <span
          aria-hidden
          className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/30 to-transparent"
        />

        <div className="relative grid gap-5 px-5 py-5 sm:grid-cols-[1.4fr_1fr] sm:px-7 sm:py-6">
          {/* Left — narrative */}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_14px_rgba(37,99,235,0.40)]">
                <Sparkles className="h-4 w-4" strokeWidth={2} />
                <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center">
                  <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
                  <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)] ring-2 ring-surface" />
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                  Today&rsquo;s operational briefing
                </span>
                <span className="text-[10px] text-ink-subtle">&middot; {dayLabel}</span>
              </div>
            </div>

            <h2 className="mt-2.5 text-[18px] font-semibold leading-snug tracking-tight text-ink sm:text-[19px]">
              {brief.headline}
            </h2>

            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
              <span className="font-semibold uppercase tracking-wider text-ink-subtle">Recommended focus &middot; </span>
              {brief.focus}
            </p>

            <div className="mt-3.5 flex items-center gap-2">
              <ConfidenceChip level={brief.confidence} variant="solid" />
              <span className="text-[10px] uppercase tracking-wider text-ink-subtle">
                Synthesized from your last 60 days
              </span>
            </div>
          </div>

          {/* Right — supporting observations */}
          <div className="relative min-w-0">
            <div className="rounded-2xl border border-border/70 bg-surface/70 p-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-sm">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                Supporting observations
              </div>
              <ul className="space-y-1.5">
                {brief.observations.map((o, i) => (
                  <li key={i} className="flex items-start gap-2 text-[12px]">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
                        o.tone === "positive" ? "bg-emerald-500" :
                        o.tone === "warning"  ? "bg-amber-500" :
                        o.tone === "brand"    ? "bg-brand-accent" :
                                                "bg-ink-subtle/60"
                      )}
                    />
                    <span className="flex-1 text-ink-muted">{o.label}</span>
                    <span className="shrink-0 tabular-nums font-semibold text-ink">{o.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Executive Narrative ───────────────────────────────────────────

function ExecutiveNarrative({ paragraphs }: { paragraphs: string[] }) {
  if (paragraphs.length === 0) return null;
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-surface via-surface to-brand-subtle/30"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/[0.08] blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      <div className="relative flex items-start gap-3 px-1 py-1">
        <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-inset text-ink-muted ring-1 ring-border/40">
          <Compass className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            Operational narrative
          </div>
          <div className="mt-1 space-y-2">
            {paragraphs.map((p, i) => (
              <p key={i} className="text-[13px] leading-relaxed text-ink-muted">
                {p}
              </p>
            ))}
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Today Rhythm Strip ────────────────────────────────────────────

function TodayRhythmStrip({ tiles }: { tiles: RhythmTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <div>
      <SectionHead
        eyebrow="Daily rhythm"
        title="Today's operational pulse"
        description="Calm, predictive signals for what to expect across the day."
      />
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((t, i) => (
          <RhythmTileCard key={i} tile={t} />
        ))}
      </div>
    </div>
  );
}

function RhythmTileCard({ tile }: { tile: RhythmTile }) {
  const Icon = tile.icon;
  const dotCls =
    tile.signal === "calm"  ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.45)]" :
    tile.signal === "watch" ? "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.45)]"  :
                              "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.45)]";
  const tint =
    tile.signal === "calm"  ? "bg-emerald-50/40 ring-emerald-200/30" :
    tile.signal === "watch" ? "bg-amber-50/40 ring-amber-200/30"   :
                              "bg-red-50/40 ring-red-200/30";
  return (
    <div className={cn(
      "group relative overflow-hidden rounded-2xl border border-border bg-surface p-3.5 shadow-soft ring-1 transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-lift",
      tint
    )}>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-center gap-2">
        <div className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-surface ring-1 ring-border/40 text-ink-muted">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{tile.label}</span>
        <span aria-hidden className={cn("ml-auto inline-block h-2 w-2 rounded-full", dotCls)} />
      </div>
      <div className="mt-2 text-[20px] font-semibold leading-none tabular-nums text-ink">{tile.value}</div>
      <div className="mt-1 text-[11px] text-ink-muted">{tile.detail}</div>
    </div>
  );
}

// ─── Predictive insights with priority hierarchy ───────────────────

function PredictiveInsights({
  exec,
  customerIntel,
}: {
  exec: ExecSummary;
  customerIntel: CustomerIntel | null;
}) {
  const insights = derivePredictiveInsights(exec, customerIntel);
  if (insights.length === 0) return null;
  const ordered = [...insights].sort(
    (a, b) => PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
  );
  return (
    <div>
      <SectionHead
        eyebrow="AI insight"
        title="Operational observations"
        description="Pattern-based observations from your trailing 60-day window. Sorted by priority — critical signals first."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ordered.map((i, idx) => (
          <InsightTile key={idx} insight={i} />
        ))}
      </div>
    </div>
  );
}

const PRIORITY_WEIGHT: Record<Priority, number> = {
  critical: 0,
  warning: 1,
  opportunity: 2,
  momentum: 3,
  optimization: 4,
};

function InsightTile({ insight }: { insight: Insight }) {
  const meta = PRIORITY_META[insight.priority];
  const Icon = meta.icon;
  return (
    <div className={cn(
      "group relative overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] ring-1",
      meta.ring,
      meta.tint,
      "hover:-translate-y-0.5 hover:shadow-lift",
    )}>
      {/* Severity rail */}
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1 rounded-l-2xl", meta.rail)} />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
      />
      <div className="relative flex items-start gap-3 pl-2">
        <div className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ring-border/40", meta.iconBg)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]", meta.chip)}>
              <span aria-hidden className={cn("inline-block h-1 w-1 rounded-full", meta.rail.split(" ")[0])} />
              {meta.label}
            </span>
            <ConfidenceChip level={insight.confidence} />
          </div>
          <h4 className="mt-0.5 text-[13px] font-semibold tracking-tight text-ink">{insight.title}</h4>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{insight.body}</p>
          <p className="mt-2 text-[10px] font-medium text-ink-subtle">
            <span className="uppercase tracking-wider">Supporting &middot; </span>
            {insight.supporting}
          </p>
        </div>
      </div>
    </div>
  );
}

const PRIORITY_META: Record<Priority, {
  label: string;
  icon: LucideIcon;
  rail: string;
  ring: string;
  tint: string;
  iconBg: string;
  chip: string;
}> = {
  critical: {
    label: "Critical",
    icon: ShieldAlert,
    rail: "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.45)]",
    ring: "ring-red-200/40",
    tint: "bg-red-50/25",
    iconBg: "bg-red-50 text-red-700",
    chip: "bg-red-50/80 text-red-700 ring-1 ring-red-200/40",
  },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    rail: "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.35)]",
    ring: "ring-amber-200/40",
    tint: "bg-amber-50/25",
    iconBg: "bg-amber-50 text-amber-700",
    chip: "bg-amber-50/80 text-amber-800 ring-1 ring-amber-200/40",
  },
  opportunity: {
    label: "Opportunity",
    icon: Target,
    rail: "bg-brand-accent shadow-[0_0_8px_rgba(37,99,235,0.40)]",
    ring: "ring-brand-accent/20",
    tint: "bg-brand-subtle/25",
    iconBg: "bg-brand-subtle text-brand-accent",
    chip: "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15",
  },
  momentum: {
    label: "Momentum",
    icon: TrendingUp,
    rail: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.35)]",
    ring: "ring-emerald-200/40",
    tint: "bg-emerald-50/25",
    iconBg: "bg-emerald-50 text-emerald-700",
    chip: "bg-emerald-50/80 text-emerald-700 ring-1 ring-emerald-200/40",
  },
  optimization: {
    label: "Optimization",
    icon: Wand2,
    rail: "bg-slate-400",
    ring: "ring-border/40",
    tint: "bg-surface-inset/30",
    iconBg: "bg-surface-inset text-ink-muted",
    chip: "bg-surface-inset text-ink-muted ring-1 ring-border/40",
  },
};

// ─── Confidence chip (humanized) ───────────────────────────────────

function ConfidenceChip({
  level,
  variant = "ghost",
}: {
  level: Confidence;
  variant?: "ghost" | "solid";
}) {
  const map: Record<Confidence, { label: string; cls: string; solid: string; dot: string }> = {
    strong: {
      label: "Strong confidence",
      cls: "bg-emerald-50/80 text-emerald-700 ring-1 ring-emerald-200/40",
      solid: "bg-emerald-500/95 text-white ring-1 ring-emerald-300/50 shadow-[0_3px_10px_rgba(16,185,129,0.35)]",
      dot: "bg-emerald-500",
    },
    moderate: {
      label: "Moderate confidence",
      cls: "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15",
      solid: "bg-brand-accent/95 text-white ring-1 ring-brand-accent/40 shadow-[0_3px_10px_rgba(37,99,235,0.35)]",
      dot: "bg-brand-accent",
    },
    early: {
      label: "Early signal",
      cls: "bg-amber-50/70 text-amber-800 ring-1 ring-amber-200/40",
      solid: "bg-amber-500/95 text-white ring-1 ring-amber-300/40 shadow-[0_3px_10px_rgba(245,158,11,0.35)]",
      dot: "bg-amber-500",
    },
    monitoring: {
      label: "Monitoring",
      cls: "bg-surface-inset text-ink-subtle ring-1 ring-border/40",
      solid: "bg-ink/85 text-white ring-1 ring-ink/30 shadow-[0_3px_10px_rgba(15,23,42,0.25)]",
      dot: "bg-ink-subtle/60",
    },
  };
  const m = map[level];
  if (variant === "solid") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]", m.solid)}>
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-white/90" />
        {m.label}
      </span>
    );
  }
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]", m.cls)}>
      <span aria-hidden className={cn("inline-block h-1 w-1 rounded-full", m.dot)} />
      {m.label}
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
  // inverse means "lower-is-better" (e.g. cancellations). MetricCard handles
  // its own visual styling via `tone`; we keep the flag for future remapping.
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
    category: string;
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
    : sev === "medium"   ? "bg-brand-accent shadow-[0_0_8px_rgba(37,99,235,0.35)]"
    :                       "bg-slate-300";
  const sevChip =
    sev === "critical" ? "bg-red-50/80 text-red-700 ring-1 ring-red-200/40"
    : sev === "high"     ? "bg-amber-50/80 text-amber-800 ring-1 ring-amber-200/40"
    : sev === "medium"   ? "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15"
    :                       "bg-surface-inset text-ink-muted ring-1 ring-border/40";

  // Phase 8B — derived operational shaping
  const impactCents = rec.projectedImpact.monthlyImpactCents;
  const impact: "low" | "medium" | "high" =
    impactCents >= 50_000 ? "high" : impactCents >= 10_000 ? "medium" : "low";
  const effort = deriveEffort(rec.category, rec.code, sev);
  const outcome = deriveOutcome(rec.category, sev);
  const ie = effortImpactLabel(effort, impact);

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-surface p-3.5 shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:scale-[1.002] hover:border-border-strong hover:shadow-lift">
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1 rounded-l-2xl", rail)} />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:opacity-100"
        style={{ boxShadow: "0 0 0 1px rgba(37,99,235,0.18), 0 10px 28px rgba(37,99,235,0.10)" }}
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

          {/* Effort × impact, outcome */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] ring-1",
              ie.cls
            )}>
              <Gauge className="h-2.5 w-2.5" strokeWidth={2} />
              {ie.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-muted ring-1 ring-border/40">
              <Telescope className="h-2.5 w-2.5" strokeWidth={2} />
              {outcome}
            </span>
            <ConfidenceChip level={numericToConfidence(rec.confidence)} />
          </div>

          {rec.supportingMetrics.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-ink-subtle">
              {rec.supportingMetrics.map((m, i) => (
                <span key={i}>
                  <span className="font-semibold text-ink-muted">{m.label}:</span> {m.value}
                </span>
              ))}
            </div>
          )}
          {impactCents > 0 && (
            <p className="mt-2 border-t border-border/40 pt-2 text-[10px] text-ink-subtle">
              {rec.projectedImpact.description}
            </p>
          )}
        </div>
        <div className="shrink-0 text-right text-[10px]">
          {impactCents > 0 && (
            <div className="inline-flex items-center gap-1 rounded-full bg-emerald-50/80 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200/40">
              +${(impactCents / 100).toFixed(0)}/mo
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function deriveEffort(category: string, code: string, severity: "low" | "medium" | "high" | "critical"): "low" | "medium" | "high" {
  // Reminders + low-severity adjustments are typically toggle-level work
  if (category === "reminders") return "low";
  if (category === "waitlist") return "low";
  if (category === "scheduling" && severity !== "critical") return "medium";
  if (category === "staffing") return severity === "critical" ? "high" : "medium";
  if (category === "revenue") return severity === "high" ? "medium" : "low";
  if (category === "customer_retention") return "medium";
  // Fallback by code-name hints
  if (code.includes("reminder") || code.includes("template")) return "low";
  if (code.includes("hire") || code.includes("staff")) return "high";
  return "medium";
}

function deriveOutcome(category: string, severity: "low" | "medium" | "high" | "critical"): string {
  switch (category) {
    case "reminders":          return severity === "critical" ? "Cut no-shows" : "Improves reliability";
    case "scheduling":         return "Smooths utilization";
    case "staffing":           return severity === "critical" ? "Relieves bottleneck" : "Balances load";
    case "revenue":            return severity === "high" ? "Recover margin" : "Lifts revenue";
    case "waitlist":           return "Captures lost demand";
    case "customer_retention": return "Strengthens retention";
    default:                   return "Improves operations";
  }
}

function effortImpactLabel(
  effort: "low" | "medium" | "high",
  impact: "low" | "medium" | "high",
): { label: string; cls: string } {
  const tier = `${effort}-${impact}`;
  // Highlight low-effort/high-impact in emerald; high-effort/low-impact dimmed
  if (effort === "low" && impact === "high")  return { label: "Low effort · High impact",  cls: "bg-emerald-50/80 text-emerald-700 ring-emerald-200/40" };
  if (effort === "low" && impact === "medium")return { label: "Low effort · Med impact",   cls: "bg-emerald-50/60 text-emerald-700 ring-emerald-200/30" };
  if (effort === "medium" && impact === "high")return{ label: "Med effort · High impact",  cls: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15" };
  if (effort === "high" && impact === "high") return { label: "High effort · High impact", cls: "bg-amber-50/80 text-amber-800 ring-amber-200/40" };
  if (effort === "high" && impact === "low")  return { label: "High effort · Low impact",  cls: "bg-surface-inset text-ink-subtle ring-border/40" };
  if (tier === "low-low")                     return { label: "Low effort · Low impact",   cls: "bg-surface-inset text-ink-muted ring-border/40" };
  return { label: `${capitalize(effort)} effort · ${capitalize(impact)} impact`, cls: "bg-surface-inset text-ink-muted ring-border/40" };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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

// ─── Phase 12B · Financial impact strip ──────────────────────────────
//
// Three executive-finance tiles that sit directly under the KPI grid:
//   1. Cancellation impact $ — the dollars cancellations are taking off
//      the table in the current period
//   2. No-show impact $ — same idea, for no-shows
//   3. Forecasted monthly revenue — pulled from
//      `extras.forecasting.projectedRevenueNext30Days` when the nightly
//      forecaster has run, with a trailing-30 fallback
//
// Every value is derived from snapshot data the cron already writes.
// No fabricated metrics.

function FinancialImpactStrip({
  cancelImpactCents,
  cancelTrendPct,
  noShowImpactCents,
  noShowCount,
  forecastedRevenueCents,
  forecastConfidence,
  forecastTrend,
}: {
  cancelImpactCents: number;
  cancelTrendPct: number;
  noShowImpactCents: number;
  noShowCount: number;
  forecastedRevenueCents: number;
  forecastConfidence: number;
  forecastTrend: "up" | "down" | "flat";
}) {
  const trendIcon =
    forecastTrend === "up" ? TrendingUp : forecastTrend === "down" ? TrendingDown : Activity;
  const trendTone =
    forecastTrend === "up" ? "positive" : forecastTrend === "down" ? "warning" : "brand";
  const trendLabel =
    forecastTrend === "up" ? "Trending up" : forecastTrend === "down" ? "Softening" : "Flat";

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-3">
      <ImpactTile
        label="Cancellation impact"
        value={dollars(cancelImpactCents)}
        detail={
          cancelTrendPct === 0
            ? "Cancellation activity is flat vs prior window."
            : cancelTrendPct > 0
              ? `Cancellations up ${cancelTrendPct}% — revenue exposure is rising.`
              : `Cancellations down ${Math.abs(cancelTrendPct)}% — exposure is easing.`
        }
        icon={CircleAlert}
        tone={cancelTrendPct > 5 ? "warning" : "neutral"}
      />
      <ImpactTile
        label="No-show impact"
        value={dollars(noShowImpactCents)}
        detail={
          noShowCount > 0
            ? `${noShowCount} no-show${noShowCount === 1 ? "" : "s"} in window × avg booking value.`
            : "No recorded no-shows this window."
        }
        icon={Flame}
        tone={noShowCount > 0 ? "warning" : "neutral"}
      />
      <ImpactTile
        label="Forecasted monthly revenue"
        value={dollars(forecastedRevenueCents)}
        detail={
          forecastConfidence >= 0.55
            ? `${trendLabel} · ${Math.round(forecastConfidence * 100)}% confidence on the projection.`
            : `${trendLabel} · early signal — the forecaster gains confidence as history accumulates.`
        }
        icon={trendIcon}
        tone={trendTone}
      />
    </div>
  );
}

function ImpactTile({
  label,
  value,
  detail,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: "positive" | "warning" | "neutral" | "brand";
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "warning"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : tone === "brand"
          ? "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15"
          : "bg-surface-inset text-ink-muted ring-border/40";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[20px] font-semibold tracking-tight text-ink">{value}</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{detail}</p>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
    </div>
  );
}

// ─── Phase 12B · Operational health strip ────────────────────────────

function OperationalHealthStrip({ tiles }: { tiles: HealthTileData[] }) {
  return (
    <div>
      <SectionHead
        eyebrow="Operational health"
        title="System pulse"
        description="Real-time health of the integrations that keep your booking flow running."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <HealthTile key={t.label} tile={t} />
        ))}
      </div>
    </div>
  );
}

function HealthTile({ tile }: { tile: HealthTileData }) {
  const Icon = tile.icon;
  const ring =
    tile.status === "healthy"
      ? "ring-emerald-200/40 bg-emerald-50/60"
      : tile.status === "warning"
        ? "ring-amber-200/40 bg-amber-50/60"
        : tile.status === "degraded"
          ? "ring-orange-200/40 bg-orange-50/60"
          : tile.status === "critical"
            ? "ring-rose-200/40 bg-rose-50/60"
            : "ring-border/40 bg-surface-inset/60";
  const dotTone =
    tile.status === "healthy"
      ? "bg-emerald-500"
      : tile.status === "warning"
        ? "bg-amber-500"
        : tile.status === "degraded"
          ? "bg-orange-500"
          : tile.status === "critical"
            ? "bg-rose-500"
            : "bg-ink-subtle";
  const dotPulse = tile.status === "healthy" || tile.status === "warning";
  const iconTone =
    tile.status === "healthy"
      ? "bg-emerald-100/80 text-emerald-700"
      : tile.status === "warning"
        ? "bg-amber-100/80 text-amber-700"
        : tile.status === "degraded"
          ? "bg-orange-100/80 text-orange-700"
          : tile.status === "critical"
            ? "bg-rose-100/80 text-rose-700"
            : "bg-surface text-ink-subtle";
  const statusLabel =
    tile.status === "healthy"
      ? "Healthy"
      : tile.status === "warning"
        ? "Warning"
        : tile.status === "degraded"
          ? "Degraded"
          : tile.status === "critical"
            ? "Critical"
            : "Idle";

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/60 p-4 ring-1 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft",
        ring,
      )}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {tile.label}
          </div>
          <div className="mt-1 text-[15px] font-semibold tracking-tight text-ink">
            {tile.primary}
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{tile.detail}</p>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      <div className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-muted">
        <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
          {dotPulse && (
            <span className={cn("absolute inset-0 inline-flex animate-ping rounded-full opacity-60", dotTone)} />
          )}
          <span className={cn("relative inline-block h-1.5 w-1.5 rounded-full", dotTone)} />
        </span>
        {statusLabel}
      </div>
    </div>
  );
}

// ─── Phase 12B · Executive timeline ──────────────────────────────────

function ExecutiveTimeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <div>
      <SectionHead
        eyebrow="Activity intelligence"
        title="Executive timeline"
        description="Notable operational events surfaced from your trailing window."
      />
      <PremiumCard className="relative overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        <ol className="relative space-y-3">
          {/* Vertical rail */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-[15px] top-1 bottom-1 w-px bg-gradient-to-b from-border via-border/60 to-transparent"
          />
          {entries.map((e, i) => (
            <TimelineEntryCard key={i} entry={e} />
          ))}
        </ol>
      </PremiumCard>
    </div>
  );
}

function TimelineEntryCard({ entry }: { entry: TimelineEntry }) {
  const Icon = entry.icon;
  const iconTone =
    entry.tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : entry.tone === "warning"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : entry.tone === "brand"
          ? "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15"
          : "bg-surface-inset text-ink-muted ring-border/40";
  return (
    <li className="relative flex items-start gap-3 pl-0">
      <span
        className={cn(
          "relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-2 ring-surface",
          iconTone,
        )}
      >
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1 pb-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[12.5px] font-semibold tracking-tight text-ink">
            {entry.headline}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            {entry.dateLabel}
          </span>
        </div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{entry.detail}</p>
      </div>
    </li>
  );
}

// ─── Phase 12B · Operational health derivation ───────────────────────
//
// All inputs come from queries that ran at page load. The function is
// pure and exhaustive — it always emits four tiles. Tiles for systems
// the tenant hasn't enabled yet render in the "idle" state so the
// strip is honest about coverage without lying about health.

function deriveOperationalHealth(input: {
  today: Date;
  snapshots: DailyAggregate[];
  connectionStatusRows: Array<{ status: string; n: number }>;
  syncLogStatusRows: Array<{ status: string; n: number }>;
  lastReport: { periodType: string; generatedAt: Date } | null;
}): HealthTileData[] {
  const { today, snapshots, connectionStatusRows, syncLogStatusRows, lastReport } = input;
  const tiles: HealthTileData[] = [];

  // 1) Calendar sync
  const totalConnections = connectionStatusRows.reduce((s, r) => s + r.n, 0);
  const activeConnections =
    connectionStatusRows.find((r) => r.status === "active")?.n ?? 0;
  const errorConnections =
    (connectionStatusRows.find((r) => r.status === "error")?.n ?? 0) +
    (connectionStatusRows.find((r) => r.status === "revoked")?.n ?? 0);
  const syncSuccess = syncLogStatusRows.find((r) => r.status === "success")?.n ?? 0;
  const syncFailure = syncLogStatusRows.find((r) => r.status === "failure")?.n ?? 0;
  const syncTotal = syncSuccess + syncFailure;
  const syncSuccessPct = syncTotal === 0 ? null : Math.round((syncSuccess / syncTotal) * 100);

  if (totalConnections === 0) {
    tiles.push({
      label: "Calendar sync",
      status: "idle",
      primary: "Not connected",
      detail: "Connect a calendar at Settings → Calendar to begin two-way sync.",
      icon: CalendarRange,
    });
  } else {
    let status: HealthStatus = "healthy";
    if (errorConnections > 0 && errorConnections >= activeConnections) status = "critical";
    else if (errorConnections > 0) status = "warning";
    else if (syncSuccessPct !== null && syncSuccessPct < 80) status = "degraded";
    else if (syncSuccessPct !== null && syncSuccessPct < 95) status = "warning";

    const primary =
      syncSuccessPct !== null ? `${syncSuccessPct}% sync success` : `${activeConnections} active`;
    const detail =
      syncTotal > 0
        ? `Last 24h · ${syncSuccess} synced · ${syncFailure} failed · ${activeConnections}/${totalConnections} connections active.`
        : `${activeConnections}/${totalConnections} connection${totalConnections === 1 ? "" : "s"} active · no sync traffic in last 24h.`;

    tiles.push({
      label: "Calendar sync",
      status,
      primary,
      detail,
      icon: CalendarRange,
    });
  }

  // 2) Reminder delivery — pulled from snapshot counters, last 7 days
  const recent7 = snapshots.slice(-7);
  const sent7 = recent7.reduce((s, r) => s + (r.reminderEmailsSent ?? 0), 0);
  const suppressed7 = recent7.reduce((s, r) => s + (r.reminderEmailsSuppressed ?? 0), 0);
  if (sent7 === 0 && suppressed7 === 0) {
    tiles.push({
      label: "Reminder delivery",
      status: "idle",
      primary: "No traffic",
      detail: "No reminder emails sent in the last 7 days.",
      icon: Mail,
    });
  } else {
    const total = sent7 + suppressed7;
    const deliveredPct = total === 0 ? 100 : Math.round((sent7 / total) * 100);
    let status: HealthStatus = "healthy";
    if (deliveredPct < 70) status = "critical";
    else if (deliveredPct < 85) status = "degraded";
    else if (deliveredPct < 95) status = "warning";
    tiles.push({
      label: "Reminder delivery",
      status,
      primary: `${deliveredPct}% delivered`,
      detail: `Last 7 days · ${sent7} sent · ${suppressed7} suppressed.`,
      icon: Mail,
    });
  }

  // 3) Booking ingestion freshness — does the most recent snapshot row
  //    cover yesterday or today? If the cron stalled, the cockpit goes
  //    blind, so we surface it.
  const latest = snapshots[snapshots.length - 1];
  if (!latest) {
    tiles.push({
      label: "Booking ingestion",
      status: "idle",
      primary: "Awaiting first snapshot",
      detail: "The nightly aggregation will populate as soon as bookings start flowing.",
      icon: ServerCog,
    });
  } else {
    const latestDate = new Date(`${latest.snapshotDate}T00:00:00Z`);
    const ageDays = Math.max(
      0,
      Math.floor((today.getTime() - latestDate.getTime()) / (24 * 60 * 60_000)),
    );
    let status: HealthStatus = "healthy";
    let primary = "Up to date";
    if (ageDays === 0) {
      primary = "Up to date";
      status = "healthy";
    } else if (ageDays === 1) {
      primary = "1 day behind";
      status = "warning";
    } else if (ageDays <= 3) {
      primary = `${ageDays} days behind`;
      status = "degraded";
    } else {
      primary = `${ageDays} days behind`;
      status = "critical";
    }
    tiles.push({
      label: "Booking ingestion",
      status,
      primary,
      detail: `Latest snapshot covers ${latest.snapshotDate} · ${latest.totalBookings} bookings recorded.`,
      icon: ServerCog,
    });
  }

  // 4) Scheduled reports — was the last scheduled report generated
  //    within its expected cadence window?
  if (!lastReport) {
    tiles.push({
      label: "Scheduled reports",
      status: "idle",
      primary: "Not configured",
      detail: "Enable scheduled reports to receive automated executive summaries.",
      icon: FileText,
    });
  } else {
    const ageMs = today.getTime() - lastReport.generatedAt.getTime();
    const ageDays = Math.floor(ageMs / (24 * 60 * 60_000));
    let status: HealthStatus = "healthy";
    let primary = "On cadence";
    if (lastReport.periodType === "weekly") {
      if (ageDays > 10) status = "critical";
      else if (ageDays > 7) status = "warning";
    } else if (lastReport.periodType === "monthly") {
      if (ageDays > 40) status = "critical";
      else if (ageDays > 32) status = "warning";
    } else if (ageDays > 3) {
      status = "warning";
    }
    if (status !== "healthy") primary = `${ageDays}d since last report`;
    tiles.push({
      label: "Scheduled reports",
      status,
      primary,
      detail: `Last generated ${lastReport.generatedAt.toISOString().slice(0, 10)} · ${capitalize(lastReport.periodType)} cadence.`,
      icon: FileText,
    });
  }

  return tiles;
}

// ─── Phase 12B · Executive timeline derivation ───────────────────────
//
// Pure derivation over the in-memory `snapshots` array. Surfaces:
//
//   - Best booking day in window
//   - Biggest cancellation spike day
//   - First waitlist conversion in window (if any)
//   - First review burst (>3 reviews completed in a day)
//   - Best revenue day (if revenue extras present)
//   - Calmest day in window (when the rest is busy)
//
// Each entry is grounded in a real row — no fabricated dates or
// fabricated counts. Returns at most 8 entries, ordered by date.

function deriveExecutiveTimeline(snapshots: DailyAggregate[]): TimelineEntry[] {
  if (snapshots.length < 3) return [];

  const entries: TimelineEntry[] = [];
  const seenDates = new Set<string>();

  const fmt = (d: string) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });

  // Best booking day
  const bestBookingDay = snapshots.reduce(
    (best, r) => ((r.totalBookings ?? 0) > (best?.totalBookings ?? 0) ? r : best),
    null as DailyAggregate | null,
  );
  if (bestBookingDay && (bestBookingDay.totalBookings ?? 0) > 0) {
    entries.push({
      kind: "booking_spike",
      dateLabel: fmt(bestBookingDay.snapshotDate),
      headline: "Highest booking day in window",
      detail: `${bestBookingDay.totalBookings} bookings — your strongest single-day volume in the trailing ${snapshots.length}-day window.`,
      tone: "positive",
      icon: PartyPopper,
    });
    seenDates.add(bestBookingDay.snapshotDate);
  }

  // Biggest cancellation spike
  const worstCancelDay = snapshots.reduce(
    (worst, r) =>
      (r.cancelledBookings ?? 0) > (worst?.cancelledBookings ?? 0) ? r : worst,
    null as DailyAggregate | null,
  );
  if (
    worstCancelDay &&
    (worstCancelDay.cancelledBookings ?? 0) >= 2 &&
    !seenDates.has(worstCancelDay.snapshotDate)
  ) {
    entries.push({
      kind: "cancel_spike",
      dateLabel: fmt(worstCancelDay.snapshotDate),
      headline: "Cancellation spike",
      detail: `${worstCancelDay.cancelledBookings} cancellation${worstCancelDay.cancelledBookings === 1 ? "" : "s"} concentrated on this date — worth a retrospective.`,
      tone: "warning",
      icon: ShieldAlert,
    });
    seenDates.add(worstCancelDay.snapshotDate);
  }

  // Best revenue day (extras.revenue.grossRevenueCents)
  const bestRevenueDay = snapshots.reduce<DailyAggregate | null>((best, r) => {
    const cur = r.extras?.revenue?.grossRevenueCents ?? 0;
    const bestVal = best?.extras?.revenue?.grossRevenueCents ?? 0;
    return cur > bestVal ? r : best;
  }, null);
  if (
    bestRevenueDay &&
    (bestRevenueDay.extras?.revenue?.grossRevenueCents ?? 0) > 0 &&
    !seenDates.has(bestRevenueDay.snapshotDate)
  ) {
    entries.push({
      kind: "revenue_milestone",
      dateLabel: fmt(bestRevenueDay.snapshotDate),
      headline: "Best revenue day in window",
      detail: `${dollars(bestRevenueDay.extras?.revenue?.grossRevenueCents ?? 0)} in gross revenue — your top single-day take this window.`,
      tone: "positive",
      icon: TrendingUp,
    });
    seenDates.add(bestRevenueDay.snapshotDate);
  }

  // First waitlist conversion in window
  const firstWaitlistDay = snapshots.find((r) => (r.waitlistConversions ?? 0) > 0);
  if (firstWaitlistDay && !seenDates.has(firstWaitlistDay.snapshotDate)) {
    entries.push({
      kind: "waitlist_conversion",
      dateLabel: fmt(firstWaitlistDay.snapshotDate),
      headline: "Waitlist converted to booking",
      detail: `${firstWaitlistDay.waitlistConversions} waitlist seat${firstWaitlistDay.waitlistConversions === 1 ? "" : "s"} filled — demand exceeding standard capacity.`,
      tone: "brand",
      icon: Megaphone,
    });
    seenDates.add(firstWaitlistDay.snapshotDate);
  }

  // First review burst (≥3 reviews in a day)
  const reviewBurstDay = snapshots.find((r) => (r.reviewsCompleted ?? 0) >= 3);
  if (reviewBurstDay && !seenDates.has(reviewBurstDay.snapshotDate)) {
    entries.push({
      kind: "review_burst",
      dateLabel: fmt(reviewBurstDay.snapshotDate),
      headline: "Review momentum",
      detail: `${reviewBurstDay.reviewsCompleted} customer reviews completed — social proof compounding.`,
      tone: "positive",
      icon: Sparkles,
    });
    seenDates.add(reviewBurstDay.snapshotDate);
  }

  // Calm window — lowest-activity day in window (only if we still
  // have spare slots and the window has otherwise been busy)
  if (entries.length < 5) {
    const avgBookings =
      snapshots.reduce((s, r) => s + (r.totalBookings ?? 0), 0) / snapshots.length;
    if (avgBookings >= 2) {
      const calmDay = snapshots.reduce(
        (calm, r) => ((r.totalBookings ?? 0) < (calm?.totalBookings ?? Infinity) ? r : calm),
        null as DailyAggregate | null,
      );
      if (calmDay && !seenDates.has(calmDay.snapshotDate)) {
        entries.push({
          kind: "calm_window",
          dateLabel: fmt(calmDay.snapshotDate),
          headline: "Quietest day in window",
          detail: `${calmDay.totalBookings} bookings — a natural day to push optimization work or reach dormant customers.`,
          tone: "neutral",
          icon: Clock,
        });
        seenDates.add(calmDay.snapshotDate);
      }
    }
  }

  // Order by date ascending so the rail reads chronologically.
  entries.sort((a, b) => (a.dateLabel < b.dateLabel ? -1 : 1));

  return entries.slice(0, 8);
}

// ─── Phase 12A · Locked executive preview ────────────────────────────
//
// What Free-plan tenants see at /dashboard/analytics/executive.
//
// The unlocked 1670-line cockpit (Phase 8A/8B) is intentionally
// untouched. This component replaces the previous 35-line amber
// `<UpgradePrompt />` with a premium preview that mirrors the
// vocabulary, layout rhythm, and honest-data discipline of the
// Phase 11 `LockedAnalyticsPreview`:
//
//   - Hero with executive eyebrow + live-pulse upgrade CTA
//   - Strategic value props (Daily brief · Forecasting · Recommendations)
//   - Executive KPI cockpit — labels only, skeleton bars (no fake values)
//   - Daily Operational Brief silhouette
//   - Forecast + Predictive insights silhouette
//   - "How the cockpit works" three-step loop (Observe → Forecast → Recommend)
//   - Plan-comparison card with current vs Pro and final CTA
//
// No data is fabricated. Every preview tile is decorative — the real
// engine fires the moment the tenant upgrades.

function LockedExecutivePreview({ currentPlanName }: { currentPlanName: string }) {
  const proPlan = getPlan("pro");
  const proFeatures = proPlan.features;

  // Executive KPI labels — the same five surfaces the unlocked
  // cockpit renders at the top of its MetricCard strip. Values
  // stay as skeleton bars, not fabricated numbers.
  const execKpis: Array<{ icon: LucideIcon; label: string; tone: string }> = [
    { icon: DollarSign,   label: "Revenue trajectory",     tone: "bg-emerald-50 text-emerald-700" },
    { icon: Users,        label: "Customer retention",     tone: "bg-violet-50 text-violet-700" },
    { icon: Gauge,        label: "Staff efficiency",       tone: "bg-brand-subtle/60 text-brand-accent" },
    { icon: Telescope,    label: "Forecast confidence",    tone: "bg-sky-50 text-sky-700" },
    { icon: Wand2,        label: "Optimization signals",   tone: "bg-amber-50 text-amber-700" },
  ];

  // Sample predictive insights — each one is a plain-language
  // example of what the engine surfaces in the unlocked cockpit.
  // Marked "Preview" so there's no chance of mistaking them for
  // real operational reads.
  const samplePredictions: Array<{ icon: LucideIcon; tone: string; title: string; body: string }> = [
    {
      icon: TrendingUp,
      tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/40",
      title: "Demand window opening",
      body: "The engine flags rising booking velocity before utilization tightens — open secondary slots while you still can.",
    },
    {
      icon: ShieldAlert,
      tone: "bg-amber-50 text-amber-700 ring-amber-200/40",
      title: "Cancellation drift detected",
      body: "When cancel rates start trending against the prior window, the cockpit surfaces it days before it shows up in revenue.",
    },
    {
      icon: Target,
      tone: "bg-brand-subtle/60 text-brand-accent ring-brand-accent/20",
      title: "Routing rebalance candidate",
      body: "Staff load distribution gets a score every day — uneven routing is flagged with a specific rebalance suggestion.",
    },
  ];

  return (
    <div className="space-y-5 pb-12">
      {/* ── Hero ─────────────────────────────────────────────── */}
      <PremiumCard className="relative overflow-hidden p-6">
        <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-accent/15 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -left-16 bottom-0 h-40 w-40 rounded-full bg-amber-400/10 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
              <Crown className="h-3 w-3" strokeWidth={2} />
              Pro feature · Executive cockpit
            </div>
            <h1 className="mt-3 text-[24px] font-semibold tracking-tight text-ink sm:text-[26px]">
              The executive view of your scheduling business.
            </h1>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-muted">
              A daily operational brief, predictive insights, multi-location performance,
              and optimization recommendations — wired to your real booking, revenue,
              and staffing data. Upgrade to {proPlan.name} to open the cockpit.
            </p>
          </div>
          <Link
            href="/dashboard/billing"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-4 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_4px_18px_rgba(37,99,235,0.30)] transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(37,99,235,0.40)]"
          >
            <span aria-hidden className="relative inline-flex h-2 w-2">
              <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-white/60" />
              <span className="relative inline-block h-2 w-2 rounded-full bg-white" />
            </span>
            Upgrade to {proPlan.name}
          </Link>
        </div>
      </PremiumCard>

      {/* ── Value props ──────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <ExecValueProp
          icon={Sun}
          title="Daily operational brief"
          body="One executive paragraph every morning — what happened, what changed, where to focus next."
        />
        <ExecValueProp
          icon={Telescope}
          title="Predictive forecasting"
          body="Revenue and demand projections with confidence bands tuned to your real booking history."
        />
        <ExecValueProp
          icon={Lightbulb}
          title="Strategic recommendations"
          body="Concrete plays scored by effort × impact — adjust hours, route bookings, fix friction points."
        />
      </div>

      {/* ── Executive KPI cockpit ────────────────────────────── */}
      <div>
        <ExecSectionLabel
          eyebrow="Cockpit metrics"
          title="Executive KPIs, locked"
          hint="Five surfaces the cockpit renders the moment you upgrade."
        />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {execKpis.map((k) => {
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
                    <div className="mt-2 space-y-1.5" aria-hidden>
                      <div className="h-5 w-3/4 animate-pulse rounded-md bg-gradient-to-r from-ink/10 via-ink/[0.06] to-transparent" />
                      <div
                        className="h-2 w-1/2 animate-pulse rounded-md bg-ink/[0.06]"
                        style={{ animationDelay: "200ms" }}
                      />
                    </div>
                  </div>
                  <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", k.tone)}>
                    <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </span>
                </div>
                <div className="mt-3 inline-flex items-center gap-1 text-[10px] font-medium text-ink-subtle">
                  <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                  Locked
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Daily operational brief silhouette ───────────────── */}
      <div>
        <ExecSectionLabel
          eyebrow="Daily brief"
          title="Today's operational read, locked"
          hint="A plain-language morning summary, surfaced when the engine has enough signal."
        />
        <div className="mt-3">
          <PremiumCard className="relative overflow-hidden p-5">
            <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-brand-accent/10 blur-3xl" />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
            <div className="relative flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-50 to-surface text-amber-700 ring-1 ring-amber-200/40">
                <Sun className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-700">
                    Morning brief
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
                    <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                    Preview
                  </span>
                </div>
                <div className="mt-2 space-y-1.5" aria-hidden>
                  <div className="h-3 w-11/12 animate-pulse rounded-md bg-gradient-to-r from-ink/10 via-ink/[0.06] to-transparent" />
                  <div className="h-3 w-10/12 animate-pulse rounded-md bg-ink/[0.06]" style={{ animationDelay: "120ms" }} />
                  <div className="h-3 w-9/12 animate-pulse rounded-md bg-ink/[0.06]" style={{ animationDelay: "220ms" }} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {["Expected daily bookings", "Revenue vs prior", "Cancellations vs prior"].map((label, i) => (
                    <div
                      key={label}
                      className="rounded-xl border border-border/60 bg-surface-inset/60 p-2.5"
                    >
                      <div className="text-[9px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                        {label}
                      </div>
                      <div
                        className="mt-1.5 h-3.5 w-1/2 animate-pulse rounded bg-ink/[0.08]"
                        style={{ animationDelay: `${i * 100}ms` }}
                        aria-hidden
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </PremiumCard>
        </div>
      </div>

      {/* ── Forecast + Predictive insights silhouette ────────── */}
      <div>
        <ExecSectionLabel
          eyebrow="Forecast & insights"
          title="Forward-looking intelligence, locked"
          hint="Confidence-banded projections + auto-surfaced strategic insights."
        />
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ChartPreviewCard
            title="60-day forecast"
            icon={LineChart}
            className="lg:col-span-2"
          >
            <ForecastSilhouette />
          </ChartPreviewCard>

          <div className="flex flex-col gap-3">
            {samplePredictions.map((s, i) => {
              const Icon = s.icon;
              return (
                <div
                  key={i}
                  className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-3.5 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
                >
                  <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
                  <div className="flex items-start gap-2.5">
                    <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1", s.tone)}>
                      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11.5px] font-semibold tracking-tight text-ink">
                          {s.title}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle ring-1 ring-border/40">
                          Preview
                        </span>
                      </div>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{s.body}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── How the cockpit works ────────────────────────────── */}
      <PremiumCard className="p-5">
        <ExecSectionLabel
          eyebrow="How it works"
          title="From operational signal to executive decision"
          hint="The cockpit runs the loop your ops team would run manually — every morning."
        />
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ExecLoopStep
            step={1}
            icon={Eye}
            title="Observe"
            body="Every booking, cancel, no-show, refund, and staff shift rolls into a daily snapshot — tenant-scoped."
          />
          <ExecLoopStep
            step={2}
            icon={Telescope}
            title="Forecast"
            body="The engine projects revenue, demand, and capacity with confidence bands tuned to your history."
          />
          <ExecLoopStep
            step={3}
            icon={Wand2}
            title="Recommend"
            body="Strategic plays scored by effort × impact — clear next moves with an expected operational outcome."
          />
        </div>
      </PremiumCard>

      {/* ── Plan comparison + CTA ────────────────────────────── */}
      <PremiumCard className="relative overflow-hidden p-5">
        <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-brand-accent/12 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute -left-12 bottom-0 h-32 w-32 rounded-full bg-amber-400/10 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative grid gap-4 lg:grid-cols-[1fr_1fr_auto] lg:items-center">
          {/* Current plan */}
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
                <span>Standard analytics dashboard locked</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                <span>Executive cockpit + daily brief locked</span>
              </li>
              <li className="flex items-start gap-1.5">
                <span aria-hidden className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                <span>Forecasting + predictive insights locked</span>
              </li>
            </ul>
          </div>

          {/* Pro plan */}
          <div className="relative rounded-xl border-2 border-brand-accent/40 bg-gradient-to-br from-brand-subtle/40 via-surface to-surface p-4 shadow-[0_8px_24px_rgba(37,99,235,0.12)]">
            <div className="absolute -top-2 right-3 inline-flex items-center gap-1 rounded-full bg-brand-accent px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white shadow-[0_4px_12px_rgba(37,99,235,0.32)]">
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
                <span className="font-medium">Executive cockpit + daily brief</span>
              </li>
              <li className="flex items-start gap-1.5">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-brand-accent" strokeWidth={2} />
                <span className="font-medium">Predictive forecasting + recommendations</span>
              </li>
            </ul>
          </div>

          {/* CTA column */}
          <div className="flex flex-col items-stretch gap-2 lg:items-end">
            <Link
              href="/dashboard/billing"
              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-accent px-4 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_4px_18px_rgba(37,99,235,0.30)] transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(37,99,235,0.40)]"
            >
              <Zap className="h-3.5 w-3.5" strokeWidth={2} />
              Unlock cockpit
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

// ─── Locked-preview helpers ───────────────────────────────────────

function ExecValueProp({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start gap-2.5">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
    </div>
  );
}

function ExecSectionLabel({
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

function ChartPreviewCard({
  title,
  icon: Icon,
  className,
  children,
}: {
  title: string;
  icon: LucideIcon;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft",
        className,
      )}
    >
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
      <div className="mt-3" aria-hidden>
        {children}
      </div>
    </div>
  );
}

// Decorative forecast silhouette — a soft, blurred area path with
// a confidence-band overlay. Pure SVG, no real data, no fabricated
// numbers — the shape is purely atmospheric.
function ForecastSilhouette() {
  return (
    <svg
      viewBox="0 0 320 90"
      className="h-32 w-full"
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id="execForecastFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2563EB" stopOpacity="0.32" />
          <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="execForecastBand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2563EB" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#2563EB" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Confidence band */}
      <path
        d="M0,60 Q40,46 80,42 T160,30 T240,22 T320,14 L320,40 Q240,50 160,56 T80,68 T0,80 Z"
        fill="url(#execForecastBand)"
      />
      {/* Trend line */}
      <path
        d="M0,68 Q40,58 80,52 T160,42 T240,30 T320,20"
        stroke="#2563EB"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        opacity="0.85"
      />
      {/* Filled trend area */}
      <path
        d="M0,68 Q40,58 80,52 T160,42 T240,30 T320,20 L320,90 L0,90 Z"
        fill="url(#execForecastFill)"
      />
      {/* Dashed projection */}
      <path
        d="M200,36 Q260,24 320,12"
        stroke="#2563EB"
        strokeWidth="1.5"
        strokeDasharray="4 4"
        fill="none"
        opacity="0.55"
      />
    </svg>
  );
}

function ExecLoopStep({
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
    <div className="relative overflow-hidden rounded-xl border border-border/60 bg-surface-inset/40 p-3.5">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start gap-2.5">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[9px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Step {step}
            </span>
            <span className="text-[12.5px] font-semibold tracking-tight text-ink">{title}</span>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
// Derivation helpers
// ───────────────────────────────────────────────────────────────────

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function numericToConfidence(n: number): Confidence {
  if (n >= 0.8) return "strong";
  if (n >= 0.55) return "moderate";
  if (n >= 0.3) return "early";
  return "monitoring";
}

function humanConfidence(c: Confidence): string {
  switch (c) {
    case "strong":     return "Strong confidence";
    case "moderate":   return "Moderate confidence";
    case "early":      return "Early signal";
    case "monitoring": return "Monitoring";
  }
}

function trailingAvg<K extends keyof DailyAggregate>(
  snapshots: DailyAggregate[],
  days: number,
  key: K,
): number {
  if (snapshots.length === 0) return 0;
  const slice = snapshots.slice(-days);
  const sum = slice.reduce((s, r) => s + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);
  return sum / slice.length;
}

function trailingSum<K extends keyof DailyAggregate>(
  snapshots: DailyAggregate[],
  days: number,
  key: K,
): number {
  if (snapshots.length === 0) return 0;
  return snapshots
    .slice(-days)
    .reduce((s, r) => s + (typeof r[key] === "number" ? (r[key] as number) : 0), 0);
}

function deriveDailyBrief(
  exec: ExecSummary,
  customerIntel: CustomerIntel | null,
  snapshots: DailyAggregate[],
): DailyBrief {
  const bookingPct = exec.bookings.comparison.percentChange;
  const revenuePct = exec.revenue.comparison.percentChange;
  const cancelPct = exec.cancellations.comparison.percentChange;
  const repeatPct = exec.repeatCustomerPct.comparison.percentChange;
  const staffPct = exec.staffEfficiency.comparison.percentChange;

  const expectedLoad = Math.round(trailingAvg(snapshots, 7, "totalBookings"));
  const lastBookings = snapshots.length > 0 ? snapshots[snapshots.length - 1].totalBookings : 0;

  let tone: DailyBrief["tone"] = "brand";
  let headline = "Operational signals are calm. Capacity, retention, and delivery remain steady.";
  let focus = "No urgent intervention needed. Continue executing the current operating plan.";

  if (cancelPct >= 20) {
    tone = "warning";
    headline = `Cancellation activity has climbed ${cancelPct}% this period. Customer commitment is softening.`;
    focus = "Tighten reminder cadence, review high-cancellation services, and surface no-show prevention plays.";
  } else if (bookingPct >= 15 && revenuePct >= 10) {
    tone = "positive";
    headline = `Booking demand is running ${bookingPct}% higher than the prior window and revenue is up ${revenuePct}%.`;
    focus = "Watch staff load. Capacity remains balanced — consider opening secondary slots before utilization tightens.";
  } else if (bookingPct <= -12) {
    tone = "warning";
    headline = `Booking volume softened ${Math.abs(bookingPct)}%. Demand signals are cooling.`;
    focus = "Run a focused outreach window to dormant customers and consider a short-duration capacity promotion.";
  } else if (customerIntel && customerIntel.retentionRate >= 65 && repeatPct >= 0) {
    tone = "positive";
    headline = `Customer relationships are holding strong — retention sits at ${customerIntel.retentionRate}% with healthy repeat behavior.`;
    focus = "Lean into VIP engagement and referral programs. The relationship layer is your operational moat.";
  } else if (revenuePct >= 5) {
    tone = "positive";
    headline = `Revenue is trending ${revenuePct}% higher than last period without operational strain.`;
    focus = "Sustain the current capacity plan. No urgent intervention needed.";
  } else if (staffPct <= -10) {
    tone = "warning";
    headline = `Staff efficiency has slipped ${Math.abs(staffPct)}% — load distribution is uneven.`;
    focus = "Review routing rules and rebalance assignments across your highest-volume services.";
  } else {
    headline = `Operational load is balanced for ${nowDayName()}. No outsized signals require executive attention.`;
    focus = "Use this calm window to address one optimization recommendation below.";
  }

  const observations: BriefObservation[] = [
    {
      label: "Expected daily bookings",
      value: String(expectedLoad),
      tone: "brand",
    },
    {
      label: "Bookings vs prior window",
      value: `${bookingPct > 0 ? "+" : ""}${bookingPct}%`,
      tone: bookingPct > 0 ? "positive" : bookingPct < 0 ? "warning" : "neutral",
    },
    {
      label: "Revenue vs prior window",
      value: `${revenuePct > 0 ? "+" : ""}${revenuePct}%`,
      tone: revenuePct > 0 ? "positive" : revenuePct < 0 ? "warning" : "neutral",
    },
    {
      label: "Cancellations vs prior",
      value: `${cancelPct > 0 ? "+" : ""}${cancelPct}%`,
      tone: cancelPct > 5 ? "warning" : cancelPct < 0 ? "positive" : "neutral",
    },
    {
      label: "Repeat customer trend",
      value: `${repeatPct > 0 ? "+" : ""}${repeatPct}%`,
      tone: repeatPct > 0 ? "positive" : repeatPct < 0 ? "warning" : "neutral",
    },
    {
      label: "Last recorded day",
      value: `${lastBookings} bookings`,
      tone: "neutral",
    },
  ];

  return {
    headline,
    observations,
    focus,
    confidence: numericToConfidence(exec.confidence),
    tone,
  };
}

function deriveExecutiveNarrative(
  exec: ExecSummary,
  customerIntel: CustomerIntel | null,
): string[] {
  const bookingPct = exec.bookings.comparison.percentChange;
  const revenuePct = exec.revenue.comparison.percentChange;
  const cancelPct = exec.cancellations.comparison.percentChange;
  const repeatPct = exec.repeatCustomerPct.comparison.percentChange;
  const staffPct = exec.staffEfficiency.comparison.percentChange;
  const avgValPct = exec.avgBookingValue.comparison.percentChange;
  const wlPct = exec.waitlistConversions.comparison.percentChange;

  const paragraphs: string[] = [];

  // Paragraph 1 — momentum line
  if (revenuePct >= 5 && staffPct >= -3) {
    paragraphs.push(
      `Revenue increased ${revenuePct}% while staff efficiency held within a healthy band — operations are scaling without strain.`
    );
  } else if (revenuePct >= 5 && staffPct < -5) {
    paragraphs.push(
      `Revenue improved ${revenuePct}%, but staff efficiency has slipped ${Math.abs(staffPct)}%. Growth is currently extracting cost from your delivery layer.`
    );
  } else if (bookingPct >= 10 && revenuePct < 5) {
    paragraphs.push(
      `Booking volume climbed ${bookingPct}% but revenue is only up ${revenuePct}%. Average booking value is ${avgValPct >= 0 ? "stable" : `down ${Math.abs(avgValPct)}%`} — the mix may be shifting toward lower-value services.`
    );
  } else if (bookingPct <= -10 && revenuePct >= 0) {
    paragraphs.push(
      `Booking volume softened ${Math.abs(bookingPct)}%, yet revenue held flat or improved — average booking value is doing the heavy lifting this period.`
    );
  } else if (Math.abs(bookingPct) < 5 && Math.abs(revenuePct) < 5) {
    paragraphs.push(
      `Booking volume and revenue are both within ±5% of the prior window — the operating cadence is steady and predictable.`
    );
  } else {
    paragraphs.push(
      `Bookings are ${bookingPct >= 0 ? "up" : "down"} ${Math.abs(bookingPct)}% and revenue is ${revenuePct >= 0 ? "up" : "down"} ${Math.abs(revenuePct)}% versus the prior window.`
    );
  }

  // Paragraph 2 — customer relationship line
  if (customerIntel) {
    if (customerIntel.retentionRate >= 60 && repeatPct >= 0) {
      paragraphs.push(
        `Retention is healthy at ${customerIntel.retentionRate}% and repeat customer behavior is ${repeatPct === 0 ? "flat" : "improving"} — the relationship layer is compounding.`
      );
    } else if (customerIntel.retentionRate < 45 && repeatPct < 0) {
      paragraphs.push(
        `Retention has eased to ${customerIntel.retentionRate}% and repeat behavior is cooling — a focused re-engagement window typically recovers about half within 30 days.`
      );
    } else if (cancelPct >= 15 && repeatPct >= 0) {
      paragraphs.push(
        `Cancellations are rising ${cancelPct}% despite holding repeat behavior — the issue is likely friction inside the booking experience, not customer affinity.`
      );
    } else {
      paragraphs.push(
        `Customer signal is mixed: retention at ${customerIntel.retentionRate}% with repeat behavior ${repeatPct >= 0 ? "stable or improving" : `down ${Math.abs(repeatPct)}%`}.`
      );
    }
  }

  // Paragraph 3 — operational pressure / opportunity line
  if (wlPct >= 20) {
    paragraphs.push(
      `Waitlist conversions are up ${wlPct}% — demand is consistently exceeding standard capacity. Opening secondary slots or expanding peak-hour availability is the highest-leverage move this period.`
    );
  } else if (cancelPct >= 20) {
    paragraphs.push(
      `Cancellation activity is up ${cancelPct}%. Tightening reminder cadence and reviewing your highest-cancellation services usually recovers about a third of lost bookings within two weeks.`
    );
  } else if (staffPct <= -10) {
    paragraphs.push(
      `Staff efficiency dropped ${Math.abs(staffPct)}% — load distribution looks uneven. Reviewing routing rules typically restores efficiency without adding headcount.`
    );
  }

  return paragraphs;
}

function deriveTodayRhythm(
  exec: ExecSummary,
  customerIntel: CustomerIntel | null,
  snapshots: DailyAggregate[],
): RhythmTile[] {
  const expectedLoad = Math.round(trailingAvg(snapshots, 7, "totalBookings"));
  const reminders7 = trailingSum(snapshots, 7, "reminderEmailsSent");
  const followups7 = trailingSum(snapshots, 7, "followupsSent");
  const cancels7 = trailingSum(snapshots, 7, "cancelledBookings");
  const total7 = trailingSum(snapshots, 7, "totalBookings");
  const cancelRate7 = total7 > 0 ? Math.round((cancels7 / total7) * 100) : 0;

  const eff = exec.staffEfficiency.comparison.currentValue;
  const cancelPct = exec.cancellations.comparison.percentChange;

  // Expected load
  const loadSignal: RhythmTile["signal"] =
    expectedLoad === 0 ? "watch" : expectedLoad < 3 ? "watch" : "calm";

  // Staffing pressure
  const staffSignal: RhythmTile["signal"] =
    eff >= 75 ? "calm" : eff >= 55 ? "watch" : "alert";

  // Follow-up risk
  const followupSignal: RhythmTile["signal"] =
    cancelPct >= 20 || cancelRate7 >= 15 ? "alert" :
    cancelPct >= 10 || cancelRate7 >= 8  ? "watch" :
                                            "calm";

  // VIP / relationship activity
  const vipValue = customerIntel ? `${customerIntel.repeatCustomerRate}%` : "—";
  const vipSignal: RhythmTile["signal"] =
    !customerIntel ? "watch" :
    customerIntel.repeatCustomerRate >= 50 ? "calm" :
    customerIntel.repeatCustomerRate >= 30 ? "watch" :
                                              "alert";

  // Automation health (reminders + follow-ups recently flowing)
  const automationActive = reminders7 + followups7 > 0;
  const automationSignal: RhythmTile["signal"] = automationActive ? "calm" : "watch";

  return [
    {
      label: "Expected load",
      value: String(expectedLoad),
      detail: `7-day avg bookings/day`,
      signal: loadSignal,
      icon: Sun,
    },
    {
      label: "Staffing pressure",
      value: `${eff}%`,
      detail: eff >= 75 ? "Balanced" : eff >= 55 ? "Watch capacity" : "Re-balance routing",
      signal: staffSignal,
      icon: Gauge,
    },
    {
      label: "Follow-up risk",
      value: `${cancelRate7}%`,
      detail: cancelRate7 >= 15 ? "Cancellation rate elevated" : cancelRate7 >= 8 ? "Within normal range" : "Low risk",
      signal: followupSignal,
      icon: Bell,
    },
    {
      label: "VIP activity",
      value: vipValue,
      detail: vipSignal === "calm" ? "Repeat behavior healthy" : vipSignal === "watch" ? "Lean into engagement" : "Re-engagement window",
      signal: vipSignal,
      icon: Crown,
    },
    {
      label: "Automation health",
      value: automationActive ? "Active" : "Idle",
      detail: automationActive
        ? `${reminders7} reminders · ${followups7} follow-ups (7d)`
        : "No automation traffic in 7d",
      signal: automationSignal,
      icon: Workflow,
    },
  ];
}

function derivePredictiveInsights(
  exec: ExecSummary,
  customerIntel: CustomerIntel | null,
): Insight[] {
  const out: Insight[] = [];
  const bookingPct = exec.bookings.comparison.percentChange;
  const cancelPct = exec.cancellations.comparison.percentChange;
  const revenuePct = exec.revenue.comparison.percentChange;
  const repeatPct = exec.repeatCustomerPct.comparison.percentChange;
  const staffPct = exec.staffEfficiency.comparison.percentChange;
  const wlPct = exec.waitlistConversions.comparison.percentChange;

  if (cancelPct >= 25) {
    out.push({
      title: "Cancellation activity is escalating",
      body: `Cancellation rate climbed ${cancelPct}% — a sustained move at this magnitude usually indicates a friction point in the booking or reminder layer.`,
      supporting: `Now ${exec.cancellations.comparison.currentValue} (was ${exec.cancellations.comparison.previousValue})`,
      priority: "critical",
      confidence: "strong",
    });
  } else if (cancelPct >= 15) {
    out.push({
      title: "Cancellations rising",
      body: `Cancellation rate up ${cancelPct}%. Reminder cadence + a short pre-call typically recovers ~30%.`,
      supporting: `Now ${exec.cancellations.comparison.currentValue} (was ${exec.cancellations.comparison.previousValue})`,
      priority: "warning",
      confidence: "moderate",
    });
  }

  if (staffPct <= -15) {
    out.push({
      title: "Staff efficiency dropping sharply",
      body: `Efficiency down ${Math.abs(staffPct)}% — load distribution is uneven. Reviewing staff routing rules typically restores efficiency without adding headcount.`,
      supporting: `Now ${exec.staffEfficiency.comparison.currentValue}% (was ${exec.staffEfficiency.comparison.previousValue}%)`,
      priority: "critical",
      confidence: "strong",
    });
  } else if (staffPct <= -8) {
    out.push({
      title: "Staff efficiency softening",
      body: `Efficiency down ${Math.abs(staffPct)}% — early sign of uneven load. Worth a routing-rule review before it compounds.`,
      supporting: `Now ${exec.staffEfficiency.comparison.currentValue}% (was ${exec.staffEfficiency.comparison.previousValue}%)`,
      priority: "warning",
      confidence: "moderate",
    });
  }

  if (bookingPct >= 12) {
    out.push({
      title: "Booking momentum accelerating",
      body: `Bookings up ${bookingPct}%. Capacity is absorbing the lift — watch staff load as the trend continues.`,
      supporting: `Now ${exec.bookings.comparison.currentValue} (was ${exec.bookings.comparison.previousValue})`,
      priority: "momentum",
      confidence: "strong",
    });
  } else if (bookingPct <= -10) {
    out.push({
      title: "Booking demand softening",
      body: `Bookings down ${Math.abs(bookingPct)}%. A short outreach to dormant customers or temporary slot promotions usually rebalances demand within two weeks.`,
      supporting: `Now ${exec.bookings.comparison.currentValue} (was ${exec.bookings.comparison.previousValue})`,
      priority: "opportunity",
      confidence: "moderate",
    });
  }

  if (revenuePct >= 10) {
    out.push({
      title: "Revenue trajectory healthy",
      body: `Revenue up ${revenuePct}% vs prior window. Average booking value at ${dollars(exec.avgBookingValue.comparison.currentValue)}.`,
      supporting: `Now ${dollars(exec.revenue.comparison.currentValue)} (was ${dollars(exec.revenue.comparison.previousValue)})`,
      priority: "momentum",
      confidence: "strong",
    });
  } else if (revenuePct <= -10) {
    out.push({
      title: "Revenue softening",
      body: `Revenue down ${Math.abs(revenuePct)}%. Likely a mix shift — check average booking value and high-revenue service uptake.`,
      supporting: `Now ${dollars(exec.revenue.comparison.currentValue)} (was ${dollars(exec.revenue.comparison.previousValue)})`,
      priority: "warning",
      confidence: "moderate",
    });
  }

  if (wlPct >= 20) {
    out.push({
      title: "Waitlist converting unusually well",
      body: `Waitlist conversions up ${wlPct}%. Demand exceeds standard capacity — opening secondary slots is the highest-leverage move this period.`,
      supporting: `Now ${exec.waitlistConversions.comparison.currentValue} (was ${exec.waitlistConversions.comparison.previousValue})`,
      priority: "opportunity",
      confidence: "moderate",
    });
  }

  if (repeatPct >= 5) {
    out.push({
      title: "Repeat customers strengthening",
      body: `Repeat customer rate up ${repeatPct}% vs prior window. Relationship layer is compounding.`,
      supporting: `Now ${exec.repeatCustomerPct.comparison.currentValue}% (was ${exec.repeatCustomerPct.comparison.previousValue}%)`,
      priority: "momentum",
      confidence: "strong",
    });
  } else if (repeatPct <= -5) {
    out.push({
      title: "Repeat behavior cooling",
      body: `Repeat customer rate dropped ${Math.abs(repeatPct)}%. A re-engagement campaign typically recovers about half within 30 days.`,
      supporting: `Now ${exec.repeatCustomerPct.comparison.currentValue}% (was ${exec.repeatCustomerPct.comparison.previousValue}%)`,
      priority: "warning",
      confidence: "moderate",
    });
  }

  if (customerIntel && customerIntel.retentionRate >= 70 && out.length < 6) {
    out.push({
      title: "Customer base highly loyal",
      body: `${customerIntel.retentionRate}% of last-period customers booked again. Lean into VIP and referral programs.`,
      supporting: `${customerIntel.bookingsByExistingCustomers} bookings from existing customers this window`,
      priority: "momentum",
      confidence: "strong",
    });
  }

  // Sprinkle an optimization-priority card when nothing critical is happening
  if (
    out.filter((i) => i.priority === "critical" || i.priority === "warning").length === 0 &&
    out.length < 6
  ) {
    out.push({
      title: "Quiet period — invest in optimization",
      body: "No outsized operational signals this window. Use this calm to address a standing recommendation below — small wins compound during quiet stretches.",
      supporting: `Confidence ${Math.round(exec.confidence * 100)}% on the current operational read`,
      priority: "optimization",
      confidence: "moderate",
    });
  }

  // Unused icon usage guard — keep CheckCircle2 / CircleDot importable for future
  void CheckCircle2;
  void CircleDot;

  return out.slice(0, 6);
}

function nowDayName(): string {
  return new Date().toLocaleDateString(undefined, { weekday: "long" });
}
