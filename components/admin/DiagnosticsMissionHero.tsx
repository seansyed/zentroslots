"use client";

/**
 * Admin Diagnostics Reliability Intelligence Hero.
 *
 * Premium top-of-page integrity strip. Every score is a deterministic
 * composite of the existing DiagnosticsBundle. NULL → "—".
 *
 * 7 KPI tiles + posture rail + insight chip row:
 *   • Overall reliability (SVG ring)
 *   • Schema integrity (SVG ring)
 *   • Snapshot freshness (SVG ring + counts)
 *   • Aggregation reliability (SVG ring + KPI pass rate)
 *   • Analytics confidence (composite SVG ring)
 *   • Cache health (SVG ring + utilization)
 *   • Operational confidence (text-only summary)
 */

import * as React from "react";
import {
  AlertTriangle,
  Boxes,
  Database,
  Gauge,
  HeartPulse,
  Loader2,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Workflow,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type {
  DiagnosticsReliabilityKpis,
  ReliabilityInsight,
  ReliabilityPosture,
} from "@/lib/admin-analytics/diagnostics-reliability";

// ─── Score ring ───────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const radius = 18;
  const stroke = 3.5;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = `${circ * pct} ${circ}`;
  const tone =
    score >= 90 ? "stroke-emerald-500" : score >= 70 ? "stroke-amber-500" : "stroke-rose-500";
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
}: {
  label: string;
  value: React.ReactNode;
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
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="text-[11px] text-slate-500">{detail ?? " "}</div>
        {accessory}
      </div>
    </div>
  );
}

// ─── Posture rail ─────────────────────────────────────────────────

const POSTURE_COPY: Record<
  ReliabilityPosture,
  { label: string; tone: string; dot: string; bg: string; sub: string }
> = {
  healthy: {
    label: "Healthy",
    tone: "text-emerald-700",
    dot: "bg-emerald-500",
    bg: "from-emerald-50/50 via-white to-white",
    sub: "All integrity checks passing. Analytics + snapshots + schema verified.",
  },
  monitoring: {
    label: "Monitoring",
    tone: "text-sky-700",
    dot: "bg-sky-500",
    bg: "from-sky-50/40 via-white to-white",
    sub: "Minor freshness drift or cache pressure — observability nominal.",
  },
  recovering: {
    label: "Recovering",
    tone: "text-amber-700",
    dot: "bg-amber-500",
    bg: "from-amber-50/50 via-white to-white",
    sub: "Recent integrity signal detected — recovery in progress.",
  },
  degraded: {
    label: "Degraded",
    tone: "text-orange-700",
    dot: "bg-orange-500",
    bg: "from-orange-50/50 via-white to-white",
    sub: "Multiple integrity surfaces below baseline — operator review recommended.",
  },
  failing: {
    label: "Failing",
    tone: "text-rose-700",
    dot: "bg-rose-500",
    bg: "from-rose-50/60 via-white to-white",
    sub: "Critical integrity signals firing — analytics layer trustworthiness reduced.",
  },
};

function PostureBanner({
  kpis,
  liveOn,
}: {
  kpis: DiagnosticsReliabilityKpis;
  liveOn: boolean;
}) {
  const p = POSTURE_COPY[kpis.posture];
  const pulsing =
    kpis.posture === "failing" || kpis.posture === "degraded" || kpis.posture === "recovering";
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-gradient-to-r ${p.bg} px-4 py-3`}
    >
      <div className="flex items-center gap-3">
        <span className="relative inline-flex h-2.5 w-2.5">
          <span
            className={`${pulsing ? "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" : "hidden"} ${p.dot}`}
          />
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${p.dot}`} />
        </span>
        <div>
          <div className="flex items-baseline gap-2">
            <span className={`text-sm font-semibold tracking-tight ${p.tone}`}>
              Platform reliability: {p.label}
            </span>
            <span className="text-[11px] text-slate-500">
              · score {kpis.overallReliabilityScore}/100 · {kpis.kpiOkCount}/{kpis.kpiTotal} KPIs OK ·{" "}
              {kpis.snapshotOkCount}/{kpis.snapshotTotal} snapshots fresh
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{p.sub}</div>
        </div>
      </div>
      {liveOn ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          Verifying
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-600">
          <Loader2 className="h-2.5 w-2.5" />
          Cached
        </span>
      )}
    </div>
  );
}

// ─── Insight chip ─────────────────────────────────────────────────

const INSIGHT_TONE: Record<
  ReliabilityInsight["tone"],
  { ring: string; bg: string; text: string; iconColor: string }
> = {
  positive: { ring: "ring-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-900", iconColor: "text-emerald-600" },
  warning: { ring: "ring-amber-200", bg: "bg-amber-50/60", text: "text-amber-900", iconColor: "text-amber-600" },
  critical: { ring: "ring-rose-200", bg: "bg-rose-50/60", text: "text-rose-900", iconColor: "text-rose-600" },
  neutral: { ring: "ring-slate-200", bg: "bg-slate-50/60", text: "text-slate-800", iconColor: "text-slate-500" },
};

export function ReliabilityInsightChip({ insight }: { insight: ReliabilityInsight }) {
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

export default function DiagnosticsMissionHero({
  kpis,
  insights,
  liveOn,
}: {
  kpis: DiagnosticsReliabilityKpis;
  insights: ReliabilityInsight[];
  liveOn: boolean;
}) {
  const heroInsights = insights.filter((i) => i.surface === "hero");
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span className="inline-flex h-1 w-1 rounded-full bg-emerald-500" />
        Reliability intelligence · deterministic verification
      </div>

      <PostureBanner kpis={kpis} liveOn={liveOn} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-7">
        <HeroTile
          label="Overall reliability"
          value={<AnimatedCounter value={kpis.overallReliabilityScore} />}
          tone={
            kpis.overallReliabilityScore >= 90
              ? "growth"
              : kpis.overallReliabilityScore >= 70
              ? "warning"
              : "critical"
          }
          Icon={ShieldCheck}
          detail="schema + KPIs + snapshots + cache"
          accessory={<ScoreRing score={kpis.overallReliabilityScore} />}
        />
        <HeroTile
          label="Schema integrity"
          value={<AnimatedCounter value={kpis.schemaIntegrity} />}
          tone={
            kpis.schemaIntegrity >= 95
              ? "growth"
              : kpis.schemaIntegrity >= 80
              ? "warning"
              : "critical"
          }
          Icon={Database}
          detail={
            kpis.schemaDriftCount === 0
              ? `${kpis.schemaTotalChecks} pairs verified`
              : `${kpis.schemaDriftCount} drift detected`
          }
          accessory={<ScoreRing score={kpis.schemaIntegrity} />}
        />
        <HeroTile
          label="Snapshot freshness"
          value={
            kpis.snapshotFreshnessConfidence === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.snapshotFreshnessConfidence} />
            )
          }
          tone={
            kpis.snapshotFreshnessConfidence === null
              ? "neutral"
              : kpis.snapshotFreshnessConfidence >= 90
              ? "growth"
              : kpis.snapshotFreshnessConfidence >= 60
              ? "warning"
              : "critical"
          }
          Icon={HeartPulse}
          detail={
            kpis.snapshotTotal === 0
              ? "no snapshot tables"
              : `${kpis.snapshotOkCount}/${kpis.snapshotTotal} fresh${kpis.snapshotStaleCount > 0 ? ` · ${kpis.snapshotStaleCount} stale` : ""}${kpis.snapshotDownCount > 0 ? ` · ${kpis.snapshotDownCount} down` : ""}`
          }
          accessory={
            kpis.snapshotFreshnessConfidence !== null ? (
              <ScoreRing score={kpis.snapshotFreshnessConfidence} />
            ) : undefined
          }
        />
        <HeroTile
          label="Aggregation reliability"
          value={
            kpis.aggregationReliability === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.aggregationReliability} />
            )
          }
          tone={
            kpis.aggregationReliability === null
              ? "neutral"
              : kpis.aggregationReliability >= 95
              ? "growth"
              : kpis.aggregationReliability >= 80
              ? "warning"
              : "critical"
          }
          Icon={Gauge}
          detail={
            kpis.kpiTotal === 0
              ? "no smoke tests"
              : `${kpis.kpiOkCount}/${kpis.kpiTotal} KPIs OK${kpis.kpiFailCount > 0 ? ` · ${kpis.kpiFailCount} failing` : ""}`
          }
          accessory={
            kpis.aggregationReliability !== null ? (
              <ScoreRing score={kpis.aggregationReliability} />
            ) : undefined
          }
        />
        <HeroTile
          label="Analytics confidence"
          value={
            kpis.analyticsConfidence === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.analyticsConfidence} />
            )
          }
          tone={
            kpis.analyticsConfidence === null
              ? "neutral"
              : kpis.analyticsConfidence >= 90
              ? "growth"
              : kpis.analyticsConfidence >= 70
              ? "warning"
              : "critical"
          }
          Icon={Sparkles}
          detail="weighted snapshots + KPIs"
          accessory={
            kpis.analyticsConfidence !== null ? (
              <ScoreRing score={kpis.analyticsConfidence} />
            ) : undefined
          }
        />
        <HeroTile
          label="Cache health"
          value={<AnimatedCounter value={kpis.cacheHealth} />}
          tone={
            kpis.cacheHealth >= 90
              ? "growth"
              : kpis.cacheHealth >= 75
              ? "primary"
              : "warning"
          }
          Icon={Boxes}
          detail={`${kpis.cacheUtilizationPct}% LRU utilization`}
          accessory={<ScoreRing score={kpis.cacheHealth} />}
        />
        <HeroTile
          label="Operational confidence"
          value={<AnimatedCounter value={kpis.overallReliabilityScore} />}
          tone={
            kpis.posture === "healthy" || kpis.posture === "monitoring"
              ? "growth"
              : kpis.posture === "recovering"
              ? "primary"
              : kpis.posture === "degraded"
              ? "warning"
              : "critical"
          }
          Icon={Workflow}
          detail={`posture: ${kpis.posture}`}
        />
      </div>

      {heroInsights.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {heroInsights.map((i) => (
            <ReliabilityInsightChip key={i.id} insight={i} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
