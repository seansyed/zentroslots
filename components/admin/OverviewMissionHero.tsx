"use client";

/**
 * Super Admin Overview Executive Hero.
 *
 * Premium top-of-page strategic intelligence strip. Every score is a
 * deterministic composite of the existing KpiBundle + page context.
 * NULL → "—".
 *
 * 8 KPI tiles + operational-status pulse rail + insight chips:
 *   • Business health (SVG ring)
 *   • Revenue momentum (SVG ring)
 *   • Growth trajectory (SVG ring)
 *   • Tenant expansion (SVG ring)
 *   • Operational confidence (SVG ring)
 *   • Platform stability (SVG ring)
 *   • Strategic opportunity (SVG ring)
 *   • Active incidents (count)
 */

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CreditCard,
  Gauge,
  HeartPulse,
  Loader2,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Workflow,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type {
  OverviewInsight,
  OverviewMissionKpis,
  OverviewOperationalStatus,
} from "@/lib/admin-analytics/overview-mission";

// ─── Score ring ───────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const radius = 18;
  const stroke = 3.5;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = `${circ * pct} ${circ}`;
  const tone =
    score >= 80 ? "stroke-emerald-500" : score >= 60 ? "stroke-sky-500" : score >= 40 ? "stroke-amber-500" : "stroke-rose-500";
  return (
    <svg width={radius * 2 + 4} height={radius * 2 + 4} className="-rotate-90">
      <circle
        cx={radius + 2}
        cy={radius + 2}
        r={norm}
        fill="none"
        strokeWidth={stroke}
        className="stroke-slate-100"
      />
      <circle
        cx={radius + 2}
        cy={radius + 2}
        r={norm}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={dash}
        className={`${tone} transition-all duration-700`}
      />
    </svg>
  );
}

// ─── KPI tile ─────────────────────────────────────────────────────

type HeroTone = "neutral" | "primary" | "growth" | "warning" | "critical";

function HeroTile({
  label,
  value,
  tone = "neutral",
  Icon,
  detail,
  accessory,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  tone?: HeroTone;
  Icon?: React.ComponentType<{ className?: string }>;
  detail?: string;
  accessory?: React.ReactNode;
  onClick?: () => void;
}) {
  const tones = {
    neutral: { border: "border-slate-200", gradient: "from-white to-slate-50/40" },
    primary: { border: "border-sky-200", gradient: "from-white via-sky-50/30 to-sky-50/60" },
    growth: { border: "border-emerald-200", gradient: "from-white to-emerald-50/40" },
    warning: { border: "border-amber-200", gradient: "from-white to-amber-50/40" },
    critical: { border: "border-rose-200", gradient: "from-white to-rose-50/40" },
  } as const;
  const t = tones[tone];
  const Tag: keyof JSX.IntrinsicElements = onClick ? "button" : "div";

  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br ${t.gradient} ${t.border} p-4 text-left shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          {label}
        </div>
        {Icon ? <Icon className="h-3.5 w-3.5 text-slate-400" /> : null}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <div
          className="text-[26px] font-semibold leading-none text-slate-900"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {value}
        </div>
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-[11px] text-slate-500">{detail ?? " "}</div>
        {accessory}
      </div>
    </Tag>
  );
}

// ─── Operational-status rail ──────────────────────────────────────

const STATUS_COPY: Record<
  OverviewOperationalStatus,
  { label: string; tone: string; dot: string; bg: string; sub: string }
> = {
  calm: {
    label: "Operating cleanly",
    tone: "text-emerald-700",
    dot: "bg-emerald-500",
    bg: "from-emerald-50/50 via-white to-white",
    sub: "Operational systems healthy · no active incidents · business posture stable.",
  },
  active: {
    label: "Active",
    tone: "text-sky-700",
    dot: "bg-sky-500",
    bg: "from-sky-50/40 via-white to-white",
    sub: "Background growth signals positive — operations nominal.",
  },
  growing: {
    label: "Growing",
    tone: "text-emerald-700",
    dot: "bg-emerald-500",
    bg: "from-emerald-50/50 via-white to-white",
    sub: "Strong momentum on revenue and/or growth axes — scaling underway.",
  },
  elevated: {
    label: "Elevated",
    tone: "text-amber-700",
    dot: "bg-amber-500",
    bg: "from-amber-50/50 via-white to-white",
    sub: "Active incidents or stability dipping — review operational signals.",
  },
  incident: {
    label: "Incident",
    tone: "text-rose-700",
    dot: "bg-rose-500",
    bg: "from-rose-50/60 via-white to-white",
    sub: "Multiple critical signals firing — operator action recommended.",
  },
};

function StatusBanner({
  kpis,
  computedInMs,
}: {
  kpis: OverviewMissionKpis;
  computedInMs: number | null;
}) {
  const s = STATUS_COPY[kpis.operationalStatus];
  const pulsing =
    kpis.operationalStatus === "incident" || kpis.operationalStatus === "elevated";
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-gradient-to-r ${s.bg} px-4 py-3`}
    >
      <div className="flex items-center gap-3">
        <span className="relative inline-flex h-2.5 w-2.5">
          <span
            className={`${pulsing ? "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" : "hidden"} ${s.dot}`}
          />
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${s.dot}`} />
        </span>
        <div>
          <div className="flex items-baseline gap-2">
            <span className={`text-sm font-semibold tracking-tight ${s.tone}`}>
              Platform: {s.label}
            </span>
            <span className="text-[11px] text-slate-500">
              · business health {kpis.businessHealthScore}/100
              {kpis.activeIncidents > 0 ? ` · ${kpis.activeIncidents} active incident${kpis.activeIncidents === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{s.sub}</div>
        </div>
      </div>
      {computedInMs !== null ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-600">
          <Loader2 className="h-2.5 w-2.5" />
          computed {computedInMs}ms
        </span>
      ) : null}
    </div>
  );
}

// ─── Insight chip ─────────────────────────────────────────────────

const INSIGHT_TONE: Record<
  OverviewInsight["tone"],
  { ring: string; bg: string; text: string; iconColor: string }
> = {
  positive: { ring: "ring-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-900", iconColor: "text-emerald-600" },
  warning: { ring: "ring-amber-200", bg: "bg-amber-50/60", text: "text-amber-900", iconColor: "text-amber-600" },
  critical: { ring: "ring-rose-200", bg: "bg-rose-50/60", text: "text-rose-900", iconColor: "text-rose-600" },
  neutral: { ring: "ring-slate-200", bg: "bg-slate-50/60", text: "text-slate-800", iconColor: "text-slate-500" },
};

export function OverviewInsightChip({ insight }: { insight: OverviewInsight }) {
  const t = INSIGHT_TONE[insight.tone];
  const Icon =
    insight.tone === "positive"
      ? TrendingUp
      : insight.tone === "warning"
      ? TrendingDown
      : insight.tone === "critical"
      ? AlertTriangle
      : Sparkles;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full ${t.bg} px-2.5 py-1 text-[11px] font-medium ring-1 ${t.ring} ${t.text}`}
      title={insight.detail}
    >
      <Icon className={`h-3 w-3 shrink-0 ${t.iconColor}`} />
      <span className="truncate">{insight.label}</span>
    </span>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────

export default function OverviewMissionHero({
  kpis,
  insights,
  computedInMs,
}: {
  kpis: OverviewMissionKpis;
  insights: OverviewInsight[];
  computedInMs: number | null;
}) {
  const heroInsights = insights.filter((i) => i.surface === "hero");
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span className="inline-flex h-1 w-1 rounded-full bg-emerald-500" />
        Executive command · cross-system intelligence
      </div>

      <StatusBanner kpis={kpis} computedInMs={computedInMs} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-8">
        <HeroTile
          label="Business health"
          value={<AnimatedCounter value={kpis.businessHealthScore} />}
          tone={
            kpis.businessHealthScore >= 80
              ? "growth"
              : kpis.businessHealthScore >= 60
              ? "warning"
              : "critical"
          }
          Icon={HeartPulse}
          detail="weighted composite"
          accessory={<ScoreRing score={kpis.businessHealthScore} />}
        />
        <HeroTile
          label="Revenue momentum"
          value={
            kpis.revenueMomentum === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.revenueMomentum} />
            )
          }
          tone={
            kpis.revenueMomentum === null
              ? "neutral"
              : kpis.revenueMomentum >= 70
              ? "growth"
              : kpis.revenueMomentum >= 40
              ? "primary"
              : "warning"
          }
          Icon={CreditCard}
          detail={
            kpis.revenueMomentum === null
              ? "no MRR / booking delta"
              : "MRR delta + booking growth"
          }
          accessory={
            kpis.revenueMomentum !== null ? <ScoreRing score={kpis.revenueMomentum} /> : undefined
          }
        />
        <HeroTile
          label="Growth trajectory"
          value={
            kpis.growthTrajectory === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.growthTrajectory} />
            )
          }
          tone={
            kpis.growthTrajectory === null
              ? "neutral"
              : kpis.growthTrajectory >= 70
              ? "growth"
              : kpis.growthTrajectory >= 40
              ? "primary"
              : "warning"
          }
          Icon={TrendingUp}
          detail={
            kpis.growthTrajectory === null ? "no signup signal" : "signup velocity + volume"
          }
          accessory={
            kpis.growthTrajectory !== null ? <ScoreRing score={kpis.growthTrajectory} /> : undefined
          }
        />
        <HeroTile
          label="Tenant expansion"
          value={<AnimatedCounter value={kpis.tenantExpansionVelocity} />}
          tone={
            kpis.tenantExpansionVelocity >= 70
              ? "growth"
              : kpis.tenantExpansionVelocity >= 40
              ? "primary"
              : "neutral"
          }
          Icon={Boxes}
          detail="active paid + bookings/tenant"
          accessory={<ScoreRing score={kpis.tenantExpansionVelocity} />}
        />
        <HeroTile
          label="Operational confidence"
          value={
            kpis.operationalConfidence === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.operationalConfidence} />
            )
          }
          tone={
            kpis.operationalConfidence === null
              ? "neutral"
              : kpis.operationalConfidence >= 90
              ? "growth"
              : kpis.operationalConfidence >= 70
              ? "warning"
              : "critical"
          }
          Icon={ShieldCheck}
          detail={
            kpis.operationalConfidence === null
              ? "no delivery/sync data"
              : "email + calendar sync avg"
          }
          accessory={
            kpis.operationalConfidence !== null ? (
              <ScoreRing score={kpis.operationalConfidence} />
            ) : undefined
          }
        />
        <HeroTile
          label="Platform stability"
          value={<AnimatedCounter value={kpis.platformStability} />}
          tone={
            kpis.platformStability >= 85
              ? "growth"
              : kpis.platformStability >= 65
              ? "warning"
              : "critical"
          }
          Icon={Activity}
          detail="100 − instability signals"
          accessory={<ScoreRing score={kpis.platformStability} />}
        />
        <HeroTile
          label="Strategic opportunity"
          value={
            kpis.strategicOpportunityScore === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.strategicOpportunityScore} />
            )
          }
          tone={
            kpis.strategicOpportunityScore === null
              ? "neutral"
              : kpis.strategicOpportunityScore >= 60
              ? "growth"
              : kpis.strategicOpportunityScore >= 30
              ? "primary"
              : "neutral"
          }
          Icon={Sparkles}
          detail={
            kpis.strategicOpportunityScore === null
              ? "no opportunity signal"
              : "trial conv + pool + velocity"
          }
          accessory={
            kpis.strategicOpportunityScore !== null ? (
              <ScoreRing score={kpis.strategicOpportunityScore} />
            ) : undefined
          }
        />
        <HeroTile
          label="Active incidents"
          value={<AnimatedCounter value={kpis.activeIncidents} />}
          tone={
            kpis.activeIncidents >= 2
              ? "critical"
              : kpis.activeIncidents > 0
              ? "warning"
              : "growth"
          }
          Icon={AlertTriangle}
          detail="past-due + OAuth + delivery + payments"
        />
      </div>

      {heroInsights.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {heroInsights.map((i) => (
            <OverviewInsightChip key={i.id} insight={i} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
