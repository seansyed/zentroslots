"use client";

/**
 * Finance Executive Hero — premium top-of-page financial cockpit.
 *
 * Seven executive-grade tiles + a deterministic insight chip row.
 * Every number is sourced from real DB queries (server-computed):
 *
 *   • Current MRR with animated counter + 12-month sparkline overlay
 *   • ARR projection (MRR × 12)
 *   • Net revenue retention (NULL at low volume → renders "—")
 *   • Expansion MRR (cents) — magnitude estimate from upgrade events
 *   • Churn impact (cents) — lost MRR last 30d
 *   • Collections velocity — MTD with MoM delta
 *   • Payment health score — composite 0-100
 *
 * Insight chips below use deterministic rules. Each chip is sourced
 * from a single threshold-tested SQL fact — never a generated claim.
 */

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  HeartPulse,
  Minus,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type { FinanceBundle } from "@/lib/admin-analytics/finance";
import type {
  FinanceExecutiveKpis,
  FinanceInsight,
} from "@/lib/admin-analytics/finance-intelligence";

// ─── Formatters ───────────────────────────────────────────────────

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

// ─── Inline sparkline ─────────────────────────────────────────────

function HeroSparkline({
  data,
  tone = "sky",
}: {
  data: number[];
  tone?: "sky" | "emerald" | "violet" | "rose" | "amber";
}) {
  const w = 120;
  const h = 32;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const points = data
    .map(
      (v, i) =>
        `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`,
    )
    .join(" ");
  const areaPoints = `0,${h} ` + points + ` ${w},${h}`;
  const tones = {
    sky: { stroke: "text-sky-500", fill: "text-sky-500/15" },
    emerald: { stroke: "text-emerald-500", fill: "text-emerald-500/15" },
    violet: { stroke: "text-violet-500", fill: "text-violet-500/15" },
    rose: { stroke: "text-rose-500", fill: "text-rose-500/15" },
    amber: { stroke: "text-amber-500", fill: "text-amber-500/15" },
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

// ─── Health ring (SVG) ────────────────────────────────────────────

function HealthRing({ score, tone }: { score: number; tone: FinanceExecutiveKpis["paymentHealthTone"] }) {
  const radius = 18;
  const stroke = 3.5;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = `${circ * pct} ${circ}`;
  const toneStroke =
    tone === "healthy"
      ? "stroke-emerald-500"
      : tone === "warning"
      ? "stroke-amber-500"
      : tone === "critical"
      ? "stroke-rose-500"
      : "stroke-slate-400";

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
        className={`${toneStroke} transition-all duration-700`}
      />
    </svg>
  );
}

// ─── KPI tile ─────────────────────────────────────────────────────

type HeroTone = "neutral" | "primary" | "growth" | "warning" | "critical";

function HeroTile({
  label,
  value,
  delta,
  sparkline,
  sparklineTone,
  tone = "neutral",
  Icon,
  detail,
  accessory,
}: {
  label: string;
  value: React.ReactNode;
  delta?: { pct: number | null; direction: "up" | "down" | "flat" } | null;
  sparkline?: number[];
  sparklineTone?: "sky" | "emerald" | "violet" | "rose" | "amber";
  tone?: HeroTone;
  Icon?: React.ComponentType<{ className?: string }>;
  detail?: string;
  accessory?: React.ReactNode;
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
      className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br ${t.gradient} ${t.border} p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)]`}
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

      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-[11px] text-slate-500">{detail ?? " "}</div>
        {accessory ?? (sparkline && sparkline.length > 0 ? (
          <HeroSparkline data={sparkline} tone={sparklineTone ?? "sky"} />
        ) : null)}
      </div>
    </div>
  );
}

// ─── Insight chip ─────────────────────────────────────────────────

const INSIGHT_TONE: Record<
  FinanceInsight["tone"],
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
  critical: {
    ring: "ring-rose-200",
    bg: "bg-rose-50/60",
    text: "text-rose-900",
    iconColor: "text-rose-600",
  },
  neutral: {
    ring: "ring-slate-200",
    bg: "bg-slate-50/60",
    text: "text-slate-800",
    iconColor: "text-slate-500",
  },
};

export function FinanceInsightChip({ insight }: { insight: FinanceInsight }) {
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

export default function FinanceExecutiveHero({
  bundle,
  kpis,
  insights,
}: {
  bundle: FinanceBundle;
  kpis: FinanceExecutiveKpis;
  insights: FinanceInsight[];
}) {
  const collectionsValues = bundle.collectionsTrend.map((m) => m.value);
  const mrrValues = bundle.mrrTrend.map((m) => m.value);
  const churnValues = bundle.churnTrend.map((m) => m.value);
  const heroInsights = insights.filter((i) => i.surface === "hero");

  return (
    <section className="space-y-3">
      {/* Eyebrow */}
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span className="inline-flex h-1 w-1 rounded-full bg-emerald-500" />
        Live · computed {kpis.computedInMs}ms ago
      </div>

      {/* KPI grid — 7 tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
        <HeroTile
          label="Current MRR"
          value={
            <AnimatedCounter
              value={kpis.currentMrrCents}
              format={(n) => fmtCurrency(n, { compact: true })}
            />
          }
          sparkline={mrrValues}
          sparklineTone="emerald"
          tone="primary"
          Icon={TrendingUp}
          detail={`${kpis.activeSubscribers} active subs`}
        />
        <HeroTile
          label="ARR projection"
          value={
            <AnimatedCounter
              value={kpis.arrCents}
              format={(n) => fmtCurrency(n, { compact: true })}
            />
          }
          sparkline={mrrValues.map((v) => v * 12)}
          sparklineTone="violet"
          tone="growth"
          Icon={Sparkles}
          detail="MRR × 12"
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
              : "(active + expansion − churn) / active"
          }
        />
        <HeroTile
          label="Expansion MRR (30d)"
          value={
            kpis.expansionMrrCents === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter
                value={kpis.expansionMrrCents}
                format={(n) => fmtCurrency(n, { compact: true })}
              />
            )
          }
          tone={kpis.expansionMrrCents && kpis.expansionMrrCents > 0 ? "growth" : "neutral"}
          Icon={ArrowUpRight}
          detail={
            kpis.expansionMrrCents === null
              ? "no upgrades in 30d"
              : "upgrade events × avg plan step"
          }
        />
        <HeroTile
          label="Churn impact (30d)"
          value={
            <AnimatedCounter
              value={kpis.churnImpactCents}
              format={(n) => (n === 0 ? "$0" : fmtCurrency(n, { compact: true }))}
            />
          }
          sparkline={churnValues}
          sparklineTone="rose"
          tone={kpis.churnImpactCents === 0 ? "neutral" : "warning"}
          Icon={ArrowDownRight}
          detail={kpis.churnImpactCents === 0 ? "no churn — clean month" : "lost MRR from cancels"}
        />
        <HeroTile
          label="Collections (MTD)"
          value={
            <AnimatedCounter
              value={kpis.collectionsThisMonthCents}
              format={(n) => fmtCurrency(n, { compact: true })}
            />
          }
          delta={
            kpis.collectionsMomPct === null
              ? null
              : {
                  pct: kpis.collectionsMomPct,
                  direction:
                    kpis.collectionsMomPct > 0
                      ? "up"
                      : kpis.collectionsMomPct < 0
                      ? "down"
                      : "flat",
                }
          }
          sparkline={collectionsValues}
          sparklineTone="emerald"
          tone="primary"
          Icon={Activity}
          detail="vs prior calendar month"
        />
        <HeroTile
          label="Payment health"
          value={
            kpis.paymentHealthScore === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.paymentHealthScore} />
            )
          }
          tone={
            kpis.paymentHealthTone === "healthy"
              ? "growth"
              : kpis.paymentHealthTone === "warning"
              ? "warning"
              : kpis.paymentHealthTone === "critical"
              ? "critical"
              : "neutral"
          }
          Icon={HeartPulse}
          detail={
            kpis.paymentHealthScore === null
              ? "needs ≥10 charges + ≥5 subs"
              : kpis.paymentSuccessRate !== null
              ? `${kpis.paymentSuccessRate}% success · ${kpis.pastDueCount} past-due`
              : "composite score"
          }
          accessory={
            kpis.paymentHealthScore !== null ? (
              <HealthRing score={kpis.paymentHealthScore} tone={kpis.paymentHealthTone} />
            ) : undefined
          }
        />
      </div>

      {/* Insight chip row */}
      {heroInsights.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {heroInsights.map((i) => (
            <FinanceInsightChip key={i.id} insight={i} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
