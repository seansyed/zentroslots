"use client";

/**
 * Super Admin Overview — Executive Command Center experience.
 *
 * Wraps the existing /admin overview data with premium UX:
 *   • OverviewMissionHero — 8-tile executive composite KPI strip
 *   • Storytelling insight chips per section
 *   • Premium revenue snapshot (gradient surfaces + tone-mapped delta)
 *   • Plan distribution with visual bars + revenue contribution + tone-
 *     mapped rows
 *   • Operational footprint with scale visualization
 *   • Cross-system command grid (Health · Finance · Intelligence ·
 *     Security · Activity · Ops · Diagnostics · Tenants)
 *
 * STRICT: NO new SQL queries — operates on the props already computed
 * by the server page. Every score is a deterministic composite.
 */

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Boxes,
  CalendarSync,
  CreditCard,
  Database,
  ExternalLink,
  FlaskConical,
  HeartPulse,
  Server,
  Shield,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Users,
  Workflow,
} from "lucide-react";

import type { KpiBundle } from "@/lib/admin-analytics/kpis";
import {
  deriveOverviewInsights,
  deriveOverviewMission,
  type OverviewInsight,
} from "@/lib/admin-analytics/overview-mission";
import OverviewMissionHero, { OverviewInsightChip } from "@/components/admin/OverviewMissionHero";

type PlanRow = {
  plan: string;
  total: number;
  active: number;
  trialing: number;
  pastDue: number;
  priceCents: number;
  /** MRR contribution: priceCents × active. */
  mrrCents: number;
};

export type OverviewExperienceProps = {
  kpis: KpiBundle | null;
  totalTenants: number;
  totalUsers: number;
  totalBookings: number;
  bookings7d: number;
  emailSent7d: number;
  emailFailures7d: number;
  expiredGoogleCount: number;
  mrrCents: number;
  trialingNow: number;
  pastDueNow: number;
  tenantsNew30d: number;
  trialConversionPct: number | null;
  planRows: PlanRow[];
};

const fmtCurrency = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents >= 100_000 ? 0 : 2,
  }).format(cents / 100);

const fmtNumber = (n: number) => new Intl.NumberFormat("en-US").format(n);

// ─── Revenue stat tile ────────────────────────────────────────────

function RevenueStat({
  label,
  value,
  delta,
  Icon,
  tone = "neutral",
  detail,
  primary,
}: {
  label: string;
  value: string;
  delta?: number | null;
  Icon: React.ComponentType<{ className?: string }>;
  tone?: "neutral" | "primary" | "growth" | "warning" | "critical";
  detail?: string;
  primary?: boolean;
}) {
  const tones = {
    neutral: { border: "border-slate-200", gradient: "from-white to-slate-50/40" },
    primary: { border: "border-sky-200", gradient: "from-white via-sky-50/30 to-sky-50/60" },
    growth: { border: "border-emerald-200", gradient: "from-white to-emerald-50/40" },
    warning: { border: "border-amber-200", gradient: "from-white to-amber-50/40" },
    critical: { border: "border-rose-200", gradient: "from-white to-rose-50/40" },
  } as const;
  const t = tones[tone];
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br ${t.gradient} ${t.border} ${primary ? "p-5 shadow-[0_2px_8px_rgba(15,23,42,0.05)]" : "p-4"} transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]`}
    >
      <div className="flex items-center justify-between gap-2">
        <div
          className={`${primary ? "text-[11px]" : "text-[10px]"} font-medium uppercase tracking-wider text-slate-500`}
        >
          {label}
        </div>
        <Icon className="h-3.5 w-3.5 text-slate-400" />
      </div>
      <div
        className={`mt-1.5 ${primary ? "text-[32px]" : "text-[22px]"} font-semibold leading-none text-slate-900`}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-[11px] text-slate-500">{detail ?? " "}</div>
        {delta !== undefined && delta !== null ? (
          <span
            className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              delta > 0
                ? "bg-emerald-50 text-emerald-700"
                : delta < 0
                ? "bg-rose-50 text-rose-700"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {delta > 0 ? (
              <ArrowUpRight className="h-2.5 w-2.5" />
            ) : delta < 0 ? (
              <ArrowDownRight className="h-2.5 w-2.5" />
            ) : null}
            {Math.abs(delta)}%
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Plan row visualization ───────────────────────────────────────

const PLAN_TONE: Record<string, { bar: string; chip: string }> = {
  free: { bar: "bg-slate-400", chip: "bg-slate-100 text-slate-600" },
  solo: { bar: "bg-sky-500", chip: "bg-sky-50 text-sky-700" },
  pro: { bar: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700" },
  team: { bar: "bg-violet-500", chip: "bg-violet-50 text-violet-700" },
  enterprise: { bar: "bg-rose-500", chip: "bg-rose-50 text-rose-700" },
};

function PlanDistribution({ rows }: { rows: PlanRow[] }) {
  const totalMrr = rows.reduce((s, r) => s + r.mrrCents, 0);
  const sorted = [...rows].sort((a, b) => b.mrrCents - a.mrrCents);
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50/80 to-white px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-semibold tracking-tight text-slate-900">
            Plan distribution
          </div>
          <div className="text-[11px] text-slate-500">
            Total MRR <span className="font-semibold text-slate-700 tabular-nums">{fmtCurrency(totalMrr)}</span>
          </div>
        </div>
      </div>
      <div className="divide-y divide-slate-100">
        {sorted.map((r) => {
          const tone = PLAN_TONE[r.plan.toLowerCase()] ?? PLAN_TONE.free;
          const mrrShare = totalMrr > 0 ? (r.mrrCents / totalMrr) * 100 : 0;
          const tenantShare =
            rows.reduce((s, x) => s + x.total, 0) > 0
              ? (r.total / rows.reduce((s, x) => s + x.total, 0)) * 100
              : 0;
          return (
            <div key={r.plan} className="px-4 py-3 transition-colors hover:bg-slate-50/40">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone.chip}`}
                  >
                    {r.plan}
                  </span>
                  <span className="text-[13px] font-semibold tabular-nums text-slate-900">
                    {r.total} tenant{r.total === 1 ? "" : "s"}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {fmtCurrency(r.priceCents)}/mo
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-slate-500">
                  {r.active > 0 ? (
                    <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      {r.active} active
                    </span>
                  ) : null}
                  {r.trialing > 0 ? (
                    <span className="rounded-full bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                      {r.trialing} trial
                    </span>
                  ) : null}
                  {r.pastDue > 0 ? (
                    <span className="rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
                      {r.pastDue} past-due
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3">
                <div>
                  <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    <span>Tenant share</span>
                    <span className="tabular-nums">{tenantShare.toFixed(1)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full ${tone.bar} transition-all duration-700`}
                      style={{ width: `${tenantShare}%` }}
                    />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    <span>MRR contribution</span>
                    <span className="tabular-nums">{fmtCurrency(r.mrrCents)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full ${tone.bar} transition-all duration-700`}
                      style={{ width: `${mrrShare}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Footprint visualization ──────────────────────────────────────

function FootprintCard({
  label,
  count,
  Icon,
  tone,
  detail,
}: {
  label: string;
  count: number;
  Icon: React.ComponentType<{ className?: string }>;
  tone: "sky" | "violet" | "emerald" | "amber" | "rose";
  detail?: string;
}) {
  const tones = {
    sky: { bg: "bg-sky-50", iconColor: "text-sky-600", ring: "ring-sky-200" },
    violet: { bg: "bg-violet-50", iconColor: "text-violet-600", ring: "ring-violet-200" },
    emerald: { bg: "bg-emerald-50", iconColor: "text-emerald-600", ring: "ring-emerald-200" },
    amber: { bg: "bg-amber-50", iconColor: "text-amber-600", ring: "ring-amber-200" },
    rose: { bg: "bg-rose-50", iconColor: "text-rose-600", ring: "ring-rose-200" },
  } as const;
  const t = tones[tone];
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50/30 p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(15,23,42,0.05)]">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ${t.bg} ${t.ring}`}>
        <Icon className={`h-4 w-4 ${t.iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
        <div
          className="mt-0.5 text-[22px] font-semibold leading-none text-slate-900"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {fmtNumber(count)}
        </div>
        {detail ? <div className="mt-1 text-[11px] text-slate-500">{detail}</div> : null}
      </div>
    </div>
  );
}

// ─── Cross-system command grid ────────────────────────────────────

const COMMAND_LINKS: Array<{
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  description: string;
  tone: "sky" | "emerald" | "violet" | "rose" | "amber" | "slate";
}> = [
  { href: "/admin/system-health", label: "Platform Health", Icon: HeartPulse, description: "Infrastructure · integrations · comms", tone: "sky" },
  { href: "/admin/finance", label: "Finance Operations", Icon: CreditCard, description: "Revenue · dunning · subscriptions", tone: "violet" },
  { href: "/admin/intelligence", label: "Operations Intelligence", Icon: Sparkles, description: "Deterministic rule-engine insights", tone: "emerald" },
  { href: "/admin/security", label: "Security & Audit", Icon: Shield, description: "Threat · audit · permission tracking", tone: "rose" },
  { href: "/admin/activity", label: "Activity Center", Icon: Activity, description: "Live operational event stream", tone: "sky" },
  { href: "/admin/ops", label: "Operator Diagnostics", Icon: Workflow, description: "Cron heartbeat · stuck queues", tone: "amber" },
  { href: "/admin/diagnostics", label: "Admin Diagnostics", Icon: Database, description: "Schema drift · KPI smoke · cache", tone: "slate" },
  { href: "/admin/dev/simulation", label: "Simulation Lab", Icon: FlaskConical, description: "Chaos engineering · synthetic data", tone: "amber" },
];

function CommandGrid() {
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
      {COMMAND_LINKS.map((c) => {
        const tones = {
          sky: { bg: "bg-sky-50", iconColor: "text-sky-600", ring: "ring-sky-200" },
          emerald: { bg: "bg-emerald-50", iconColor: "text-emerald-600", ring: "ring-emerald-200" },
          violet: { bg: "bg-violet-50", iconColor: "text-violet-600", ring: "ring-violet-200" },
          rose: { bg: "bg-rose-50", iconColor: "text-rose-600", ring: "ring-rose-200" },
          amber: { bg: "bg-amber-50", iconColor: "text-amber-600", ring: "ring-amber-200" },
          slate: { bg: "bg-slate-100", iconColor: "text-slate-600", ring: "ring-slate-200" },
        } as const;
        const t = tones[c.tone];
        return (
          <a
            key={c.href}
            href={c.href}
            className="group inline-flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_4px_18px_rgba(15,23,42,0.06)]"
          >
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ${t.bg} ${t.ring}`}>
              <c.Icon className={`h-4 w-4 ${t.iconColor}`} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold tracking-tight text-slate-900">{c.label}</div>
              <div className="text-[11px] text-slate-500">{c.description}</div>
            </div>
            <ExternalLink className="h-3 w-3 shrink-0 text-slate-300 transition-colors group-hover:text-slate-500" />
          </a>
        );
      })}
    </div>
  );
}

// ─── Top-level ────────────────────────────────────────────────────

export default function OverviewExperience(props: OverviewExperienceProps) {
  const {
    kpis,
    totalTenants,
    totalUsers,
    totalBookings,
    bookings7d,
    emailSent7d,
    emailFailures7d,
    expiredGoogleCount,
    mrrCents,
    trialingNow,
    pastDueNow,
    tenantsNew30d,
    trialConversionPct,
    planRows,
  } = props;

  const mission = deriveOverviewMission({
    kpis,
    context: {
      totalTenants,
      totalUsers,
      totalBookings,
      bookings7d,
      emailSent7d,
      emailFailures7d,
      expiredGoogleCount,
      mrrCents,
      trialingNow,
      pastDueNow,
      tenantsNew30d,
      trialConversionPct,
    },
  });
  const insights = deriveOverviewInsights({
    kpis,
    mission,
    context: {
      bookings7d,
      emailSent7d,
      emailFailures7d,
      expiredGoogleCount,
      pastDueNow,
      trialingNow,
      trialConversionPct,
    },
  });

  const revenueInsight = insights.find((i) => i.surface === "revenue") ?? null;
  const plansInsight = insights.find((i) => i.surface === "plans") ?? null;
  const footprintInsight = insights.find((i) => i.surface === "footprint") ?? null;
  const opsInsight = insights.find((i) => i.surface === "ops") ?? null;

  const mrrDelta = kpis?.totalMrr?.deltaPct ?? null;
  const arrDelta = kpis?.arrProjection?.deltaPct ?? null;
  const tenantsDelta = kpis?.activePaidTenants?.deltaPct ?? null;
  const bookingsDelta = kpis?.totalBookings?.deltaPct ?? null;

  return (
    <div className="space-y-7">
      {/* Mission hero */}
      <OverviewMissionHero
        kpis={mission}
        insights={insights}
        computedInMs={kpis?.computedInMs ?? null}
      />

      {/* Cross-system command grid */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Server className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Cross-system command
          </h2>
          <span className="text-[11px] text-slate-400">jump to any mission-control surface</span>
        </div>
        <CommandGrid />
      </section>

      {/* Revenue snapshot — primary metrics */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <CreditCard className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Revenue snapshot
          </h2>
          {revenueInsight ? (
            <div className="ml-2">
              <OverviewInsightChip insight={revenueInsight} />
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <RevenueStat
            label="Current MRR"
            value={fmtCurrency(mrrCents)}
            delta={mrrDelta}
            Icon={CreditCard}
            tone="primary"
            detail="active subscriptions"
            primary
          />
          <RevenueStat
            label="ARR projection"
            value={fmtCurrency(mrrCents * 12)}
            delta={arrDelta}
            Icon={TrendingUp}
            tone="growth"
            detail="MRR × 12"
            primary
          />
          <RevenueStat
            label="Active paid tenants"
            value={fmtNumber(Number(kpis?.activePaidTenants?.value ?? 0))}
            delta={tenantsDelta}
            Icon={Users}
            tone="growth"
            detail="subscription_status = active"
            primary
          />
          <RevenueStat
            label="Trial → paid (30d)"
            value={trialConversionPct !== null ? `${trialConversionPct}%` : "—"}
            Icon={Sparkles}
            tone={
              trialConversionPct !== null && trialConversionPct >= 25
                ? "growth"
                : trialConversionPct !== null && trialConversionPct < 10
                ? "warning"
                : "neutral"
            }
            detail="conversion proxy"
            primary
          />
        </div>
      </section>

      {/* Plan distribution */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Boxes className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Plan distribution
          </h2>
          {plansInsight ? (
            <div className="ml-2">
              <OverviewInsightChip insight={plansInsight} />
            </div>
          ) : null}
        </div>
        <PlanDistribution rows={planRows} />
      </section>

      {/* Operational footprint */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Activity className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Operational footprint
          </h2>
          <span className="text-[11px] text-slate-400">platform-scale visualization</span>
          {footprintInsight ? (
            <div className="ml-2">
              <OverviewInsightChip insight={footprintInsight} />
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
          <FootprintCard label="Tenants" count={totalTenants} Icon={Boxes} tone="sky" detail={`${tenantsNew30d} joined 30d`} />
          <FootprintCard label="Users" count={totalUsers} Icon={Users} tone="violet" />
          <FootprintCard label="Bookings" count={totalBookings} Icon={CalendarSync} tone="emerald" detail={`${bookings7d} in 7d`} />
          <FootprintCard
            label="Trialing now"
            count={trialingNow}
            Icon={Sparkles}
            tone={trialingNow > 0 ? "amber" : "sky"}
          />
          <FootprintCard
            label="Past-due"
            count={pastDueNow}
            Icon={AlertTriangle}
            tone={pastDueNow > 0 ? "rose" : "sky"}
            detail={pastDueNow > 0 ? "needs dunning attention" : "clean"}
          />
        </div>
      </section>

      {/* 7-day operational health */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <ShieldAlert className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            7-day ops health
          </h2>
          {opsInsight ? (
            <div className="ml-2">
              <OverviewInsightChip insight={opsInsight} />
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FootprintCard label="Bookings (7d)" count={bookings7d} Icon={CalendarSync} tone="emerald" />
          <FootprintCard label="Emails sent (7d)" count={emailSent7d} Icon={Activity} tone="sky" />
          <FootprintCard
            label="Email failures (7d)"
            count={emailFailures7d}
            Icon={AlertTriangle}
            tone={emailFailures7d > 0 ? "amber" : "sky"}
            detail={
              emailSent7d + emailFailures7d >= 50
                ? `${Math.round((emailFailures7d / (emailSent7d + emailFailures7d)) * 1000) / 10}% rate`
                : undefined
            }
          />
        </div>
      </section>
    </div>
  );
}
