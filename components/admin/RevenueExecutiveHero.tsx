"use client";

/**
 * Revenue Executive Hero — premium top-of-page intelligence strip.
 *
 * Five executive-grade tiles + a deterministic insight chip row.
 * Every number is sourced from real DB queries (server-computed):
 *
 *   • Current MRR with animated counter + 12-month sparkline overlay
 *   • ARR (MRR × 12) with same sparkline
 *   • MoM growth %  — null when prior month is $0 (renders "—", never fake)
 *   • Active subscribers — paid-plan tenant count
 *   • Net retention proxy — null at low volume (<20 subs)
 *
 * Insight chips below use deterministic rules. Each chip is sourced
 * from a single threshold-tested SQL fact — never a generated claim.
 */

import * as React from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type { RevenueSeries } from "@/lib/admin-analytics/revenue";
import type {
  RevenueExecutiveKpis,
  RevenueInsight,
} from "@/lib/admin-analytics/revenue-intelligence";

const fmtCurrency = (cents: number, opts: { compact?: boolean } = {}) => {
  if (opts.compact && cents >= 100_000_00) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(cents / 100);
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents >= 100_000 ? 0 : 2,
  }).format(cents / 100);
};

// ─── Inline sparkline (single executive line, 12 months) ──────────

function HeroSparkline({ data, tone = "sky" }: { data: number[]; tone?: "sky" | "emerald" | "violet" }) {
  const w = 120;
  const h = 32;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  const areaPoints =
    `0,${h} ` +
    points +
    ` ${w},${h}`;
  const tones = {
    sky: { stroke: "text-sky-500", fill: "text-sky-500/15" },
    emerald: { stroke: "text-emerald-500", fill: "text-emerald-500/15" },
    violet: { stroke: "text-violet-500", fill: "text-violet-500/15" },
  } as const;
  const t = tones[tone];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <polyline points={areaPoints} fill="currentColor" stroke="none" className={t.fill} />
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={t.stroke}
      />
    </svg>
  );
}

// ─── KPI tile ─────────────────────────────────────────────────────

type HeroTone = "neutral" | "primary" | "growth" | "warning";

function HeroTile({
  label,
  value,
  delta,
  sparkline,
  sparklineTone,
  tone = "neutral",
  Icon,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  delta?: { pct: number | null; direction: "up" | "down" | "flat" } | null;
  sparkline?: number[];
  sparklineTone?: "sky" | "emerald" | "violet";
  tone?: HeroTone;
  Icon?: React.ComponentType<{ className?: string }>;
  detail?: string;
}) {
  const tones = {
    neutral: { border: "border-slate-200", gradient: "from-white to-slate-50/40" },
    primary: { border: "border-sky-200", gradient: "from-white via-sky-50/30 to-sky-50/60" },
    growth: { border: "border-emerald-200", gradient: "from-white to-emerald-50/40" },
    warning: { border: "border-amber-200", gradient: "from-white to-amber-50/40" },
  } as const;
  const t = tones[tone];

  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br ${t.gradient} ${t.border} p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]`}
    >
      {/* Top: label + optional icon */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
          {label}
        </div>
        {Icon ? <Icon className="h-3.5 w-3.5 text-slate-400" /> : null}
      </div>

      {/* Value + delta */}
      <div className="mt-1.5 flex items-baseline gap-2">
        <div
          className="text-[26px] font-semibold leading-none text-slate-900"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {value}
        </div>
        {delta && delta.pct !== null ? (
          <span
            className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              delta.direction === "up"
                ? "bg-emerald-50 text-emerald-700"
                : delta.direction === "down"
                ? "bg-rose-50 text-rose-700"
                : "bg-slate-100 text-slate-600"
            }`}
          >
            {delta.direction === "up" ? (
              <ArrowUpRight className="h-2.5 w-2.5" />
            ) : delta.direction === "down" ? (
              <ArrowDownRight className="h-2.5 w-2.5" />
            ) : (
              <Minus className="h-2.5 w-2.5" />
            )}
            {Math.abs(delta.pct)}%
          </span>
        ) : null}
      </div>

      {/* Sparkline + detail */}
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-[11px] text-slate-500">{detail ?? " "}</div>
        {sparkline && sparkline.length > 0 ? (
          <HeroSparkline data={sparkline} tone={sparklineTone ?? "sky"} />
        ) : null}
      </div>
    </div>
  );
}

// ─── Insight chip ─────────────────────────────────────────────────

const INSIGHT_TONE: Record<
  RevenueInsight["tone"],
  { ring: string; bg: string; text: string; iconColor: string }
> = {
  positive: {
    ring: "ring-emerald-200",
    bg: "bg-emerald-50/60",
    text: "text-emerald-900",
    iconColor: "text-emerald-600",
  },
  warning: {
    ring: "ring-amber-200",
    bg: "bg-amber-50/60",
    text: "text-amber-900",
    iconColor: "text-amber-600",
  },
  neutral: {
    ring: "ring-slate-200",
    bg: "bg-slate-50/60",
    text: "text-slate-800",
    iconColor: "text-slate-500",
  },
};

function InsightChip({ insight }: { insight: RevenueInsight }) {
  const t = INSIGHT_TONE[insight.tone];
  const Icon =
    insight.tone === "positive" ? TrendingUp : insight.tone === "warning" ? TrendingDown : Sparkles;
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

export default function RevenueExecutiveHero({
  series,
  kpis,
  insights,
}: {
  series: RevenueSeries;
  kpis: RevenueExecutiveKpis;
  insights: RevenueInsight[];
}) {
  const monthlyValues = series.monthlyRevenue.map((m) => m.value);
  const bookingValues = series.bookingsByMonth.map((m) => m.value);
  const heroInsights = insights.filter((i) => i.surface === "hero");

  const growthDelta =
    kpis.momGrowthPct === null
      ? null
      : {
          pct: kpis.momGrowthPct,
          direction:
            kpis.momGrowthPct > 0 ? "up" : kpis.momGrowthPct < 0 ? "down" : ("flat" as const),
        };

  return (
    <section className="space-y-3">
      {/* Executive eyebrow */}
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span className="inline-flex h-1 w-1 rounded-full bg-emerald-500" />
        Live · computed {kpis.computedInMs}ms ago
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <HeroTile
          label="Current MRR"
          value={
            <AnimatedCounter
              value={kpis.currentMrrCents}
              format={(n) => fmtCurrency(n, { compact: true })}
            />
          }
          delta={growthDelta as { pct: number | null; direction: "up" | "down" | "flat" } | null}
          sparkline={monthlyValues}
          sparklineTone="emerald"
          tone="primary"
          Icon={TrendingUp}
          detail="vs prior month revenue"
        />
        <HeroTile
          label="ARR projection"
          value={
            <AnimatedCounter
              value={kpis.arrCents}
              format={(n) => fmtCurrency(n, { compact: true })}
            />
          }
          sparkline={monthlyValues.map((v) => v * 12)}
          sparklineTone="violet"
          tone="growth"
          Icon={Sparkles}
          detail="MRR × 12"
        />
        <HeroTile
          label="Active subscribers"
          value={<AnimatedCounter value={kpis.activeSubscribers} />}
          sparkline={bookingValues}
          sparklineTone="sky"
          tone="neutral"
          Icon={Users}
          detail={
            kpis.avgRevenuePerSubCents !== null
              ? `${fmtCurrency(kpis.avgRevenuePerSubCents)} / sub · ARPU`
              : "no paid subscribers"
          }
        />
        <HeroTile
          label="Net retention"
          value={
            kpis.nrrEstimate === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              `${Math.round(kpis.nrrEstimate * 100)}%`
            )
          }
          tone={
            kpis.nrrEstimate === null
              ? "neutral"
              : kpis.nrrEstimate >= 1
              ? "growth"
              : "warning"
          }
          Icon={Zap}
          detail={
            kpis.nrrEstimate === null
              ? "needs ≥20 active subs"
              : `${kpis.upgrades30d} upgrades · ${kpis.churn30d} churn (30d)`
          }
        />
        <HeroTile
          label="Trial conversion"
          value={
            kpis.trialConversionPct === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              `${kpis.trialConversionPct}%`
            )
          }
          tone={
            kpis.trialConversionPct === null
              ? "neutral"
              : kpis.trialConversionPct >= 20
              ? "growth"
              : "warning"
          }
          Icon={ArrowUpRight}
          detail={
            kpis.trialConversionPct === null
              ? "no trials ended in 60d"
              : "trials ended in last 60d that are now paid"
          }
        />
      </div>

      {/* Insight chip row — only renders when at least one hero insight fires */}
      {heroInsights.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {heroInsights.map((i) => (
            <InsightChip key={i.id} insight={i} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
