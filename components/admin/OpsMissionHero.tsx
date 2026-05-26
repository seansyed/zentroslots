"use client";

/**
 * Operator Diagnostics Executive Mission Hero — premium top-of-page
 * operations strip. Every score is a deterministic composite of the
 * existing OpsDiagnosticsBundle (cron_runs + audit_logs).
 *
 * Eight KPI tiles + platform-status pulse rail:
 *   • Cron health (SVG ring)
 *   • Infra confidence (SVG ring)
 *   • Queue pressure (SVG ring, inverted)
 *   • Failure velocity (count + ratio)
 *   • Automation reliability (SVG ring)
 *   • Incident severity (SVG ring, inverted)
 *   • Live throughput (cron runs last 60min)
 *   • Critical failures (last hour count)
 */

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Cpu,
  Database,
  HeartPulse,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Workflow,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type { OpsInsight, OpsMissionKpis, OpsPlatformStatus } from "@/lib/admin-analytics/ops-mission";

// ─── Score ring ───────────────────────────────────────────────────

function ScoreRing({
  score,
  invert,
}: {
  score: number;
  invert?: boolean;
}) {
  const radius = 18;
  const stroke = 3.5;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = `${circ * pct} ${circ}`;
  const tone = invert
    ? score >= 60
      ? "stroke-rose-500"
      : score >= 30
      ? "stroke-amber-500"
      : "stroke-emerald-500"
    : score >= 80
    ? "stroke-emerald-500"
    : score >= 60
    ? "stroke-amber-500"
    : "stroke-rose-500";
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

// ─── Status rail ──────────────────────────────────────────────────

const STATUS_COPY: Record<
  OpsPlatformStatus,
  { label: string; tone: string; dot: string; bg: string; sub: string }
> = {
  calm: {
    label: "Healthy",
    tone: "text-emerald-700",
    dot: "bg-emerald-500",
    bg: "from-emerald-50/50 via-white to-white",
    sub: "All cron jobs OK, no stuck queues, no critical failures.",
  },
  active: {
    label: "Active",
    tone: "text-sky-700",
    dot: "bg-sky-500",
    bg: "from-sky-50/40 via-white to-white",
    sub: "Cron workers actively processing — operations nominal.",
  },
  degraded: {
    label: "Degraded",
    tone: "text-amber-700",
    dot: "bg-amber-500",
    bg: "from-amber-50/50 via-white to-white",
    sub: "Stale crons or queue backlog detected — investigate.",
  },
  stalled: {
    label: "Stalled",
    tone: "text-orange-700",
    dot: "bg-orange-500",
    bg: "from-orange-50/50 via-white to-white",
    sub: "One or more critical paths blocked — operator action required.",
  },
  critical: {
    label: "Critical",
    tone: "text-rose-700",
    dot: "bg-rose-500",
    bg: "from-rose-50/60 via-white to-white",
    sub: "Multiple failure signals firing — immediate operator response required.",
  },
};

function StatusBanner({
  kpis,
  liveOn,
}: {
  kpis: OpsMissionKpis;
  liveOn: boolean;
}) {
  const s = STATUS_COPY[kpis.platformStatus];
  const pulsing =
    kpis.platformStatus === "critical" ||
    kpis.platformStatus === "stalled" ||
    kpis.platformStatus === "degraded";
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
              · {kpis.cronStatusCounts.ok + kpis.cronStatusCounts.running} jobs healthy ·{" "}
              {kpis.cronStatusCounts.down} down · {kpis.stuckQueuesCount} stuck queue
              {kpis.stuckQueuesCount === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{s.sub}</div>
        </div>
      </div>
      {liveOn ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          Live
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
  OpsInsight["tone"],
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

export function OpsInsightChip({ insight }: { insight: OpsInsight }) {
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

export default function OpsMissionHero({
  kpis,
  insights,
  liveOn,
}: {
  kpis: OpsMissionKpis;
  insights: OpsInsight[];
  liveOn: boolean;
}) {
  const heroInsights = insights.filter((i) => i.surface === "hero");
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span className="inline-flex h-1 w-1 rounded-full bg-emerald-500" />
        Mission control · deterministic diagnostics
      </div>

      <StatusBanner kpis={kpis} liveOn={liveOn} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-8">
        <HeroTile
          label="Cron health"
          value={
            kpis.cronHealthScore === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <>
                <AnimatedCounter value={kpis.cronHealthScore} />
                <span className="ml-0.5 text-[14px] font-medium text-slate-400">%</span>
              </>
            )
          }
          tone={
            kpis.cronHealthScore === null
              ? "neutral"
              : kpis.cronHealthScore >= 90
              ? "growth"
              : kpis.cronHealthScore >= 70
              ? "warning"
              : "critical"
          }
          Icon={HeartPulse}
          detail={`${kpis.cronStatusCounts.ok}/${
            kpis.cronStatusCounts.ok +
            kpis.cronStatusCounts.stale +
            kpis.cronStatusCounts.down +
            kpis.cronStatusCounts.running +
            kpis.cronStatusCounts.unknown
          } jobs OK`}
          accessory={
            kpis.cronHealthScore !== null ? <ScoreRing score={kpis.cronHealthScore} /> : undefined
          }
        />
        <HeroTile
          label="Infra confidence"
          value={<AnimatedCounter value={kpis.infraConfidence} />}
          tone={
            kpis.infraConfidence >= 80
              ? "growth"
              : kpis.infraConfidence >= 60
              ? "warning"
              : "critical"
          }
          Icon={ShieldCheck}
          detail="cron + queue + failure composite"
          accessory={<ScoreRing score={kpis.infraConfidence} />}
        />
        <HeroTile
          label="Queue pressure"
          value={<AnimatedCounter value={kpis.queuePressure} />}
          tone={
            kpis.queuePressure >= 60
              ? "critical"
              : kpis.queuePressure >= 30
              ? "warning"
              : kpis.queuePressure === 0
              ? "growth"
              : "neutral"
          }
          Icon={Database}
          detail={
            kpis.queuePressure === 0
              ? "no queues backed up"
              : `${kpis.stuckQueuesCount} queue${kpis.stuckQueuesCount === 1 ? "" : "s"} backed up`
          }
          accessory={<ScoreRing score={kpis.queuePressure} invert />}
        />
        <HeroTile
          label="Failure velocity"
          value={<AnimatedCounter value={kpis.failuresLastHour} />}
          tone={
            kpis.failureVelocityRatio !== null && kpis.failureVelocityRatio >= 3
              ? "critical"
              : kpis.failureVelocityRatio !== null && kpis.failureVelocityRatio >= 2
              ? "warning"
              : kpis.failuresLastHour === 0
              ? "growth"
              : "primary"
          }
          Icon={AlertTriangle}
          detail={
            kpis.failureVelocityRatio === null
              ? `${kpis.recentFailures24h} total in 24h`
              : `${kpis.failureVelocityRatio}× normal rate`
          }
        />
        <HeroTile
          label="Automation reliability"
          value={<AnimatedCounter value={kpis.automationReliability} />}
          tone={
            kpis.automationReliability >= 80
              ? "growth"
              : kpis.automationReliability >= 60
              ? "warning"
              : "critical"
          }
          Icon={Workflow}
          detail="automations:run + queue composite"
          accessory={<ScoreRing score={kpis.automationReliability} />}
        />
        <HeroTile
          label="Incident severity"
          value={<AnimatedCounter value={kpis.incidentSeverity} />}
          tone={
            kpis.incidentSeverity >= 60
              ? "critical"
              : kpis.incidentSeverity >= 30
              ? "warning"
              : kpis.incidentSeverity === 0
              ? "growth"
              : "neutral"
          }
          Icon={ShieldAlert}
          detail={
            kpis.incidentSeverity === 0
              ? "no active incidents"
              : "down crons + crashes + critical queues"
          }
          accessory={<ScoreRing score={kpis.incidentSeverity} invert />}
        />
        <HeroTile
          label="Live throughput"
          value={<AnimatedCounter value={kpis.liveThroughput} />}
          tone={
            kpis.liveThroughput === 0
              ? "warning"
              : kpis.liveThroughput >= 5
              ? "growth"
              : "primary"
          }
          Icon={Activity}
          detail={kpis.liveThroughput === 0 ? "no jobs ran in last 60min" : "jobs run · last 60min"}
        />
        <HeroTile
          label="Critical failures"
          value={<AnimatedCounter value={kpis.criticalFailuresLastHour} />}
          tone={
            kpis.criticalFailuresLastHour >= 3
              ? "critical"
              : kpis.criticalFailuresLastHour > 0
              ? "warning"
              : "growth"
          }
          Icon={Zap}
          detail="crash + fatal events · 1h"
        />
      </div>

      {heroInsights.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {heroInsights.map((i) => (
            <OpsInsightChip key={i.id} insight={i} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
