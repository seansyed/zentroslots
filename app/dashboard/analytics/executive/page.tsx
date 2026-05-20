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
            </div>
          </FadeIn>
        )}

        {/* Predictive insights with priority hierarchy */}
        {exec && (
          <FadeIn delay={5}>
            <PredictiveInsights exec={exec} customerIntel={hasCustomerData ? customerIntel : null} />
          </FadeIn>
        )}

        {/* Multi-location + Department */}
        {(hasLocations || hasDepartments) && (
          <FadeIn delay={6}>
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
          <FadeIn delay={7}>
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
          <FadeIn delay={8}>
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
            "radial-gradient(800px 220px at 80% 0%, rgba(53,157,243,0.06), transparent 70%), radial-gradient(600px 200px at 0% 100%, rgba(16,185,129,0.05), transparent 70%)",
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
            <span className="zm-pulse-glow inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
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
              "radial-gradient(700px 200px at 70% 10%, rgba(53,157,243,0.06), transparent 70%), radial-gradient(500px 180px at 10% 90%, rgba(16,185,129,0.05), transparent 70%)",
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
              <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_14px_rgba(53,157,243,0.40)]">
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
    rail: "bg-brand-accent shadow-[0_0_8px_rgba(53,157,243,0.40)]",
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
      solid: "bg-brand-accent/95 text-white ring-1 ring-brand-accent/40 shadow-[0_3px_10px_rgba(53,157,243,0.35)]",
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
    : sev === "medium"   ? "bg-brand-accent shadow-[0_0_8px_rgba(53,157,243,0.35)]"
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
