"use client";

/**
 * Simulation Mission Control Hero — premium chaos-lab top strip.
 *
 * Every score is a deterministic composite of the synthetic footprint.
 * NULL → "—". Operates ONLY on synthetic data — never touches real
 * customer rows (the seed-marker architecture guarantees this at the
 * lib boundary).
 *
 * 7 KPI tiles + lab-status pulse rail + insight chip row:
 *   • Simulation intensity (SVG ring)
 *   • Realism score (SVG ring)
 *   • Operational coverage (SVG ring)
 *   • Synthetic footprint health (SVG ring)
 *   • Telemetry velocity (count)
 *   • Synthetic load (SVG ring)
 *   • Safety confidence (SVG ring)
 */

import * as React from "react";
import {
  AlertTriangle,
  Boxes,
  FlaskConical,
  Gauge,
  Loader2,
  Radar,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Workflow,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type {
  SimulationInsight,
  SimulationLabStatus,
  SimulationMissionKpis,
} from "@/lib/dev-seeding/simulation-mission";

// ─── Score ring ───────────────────────────────────────────────────

function ScoreRing({ score }: { score: number }) {
  const radius = 18;
  const stroke = 3.5;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = `${circ * pct} ${circ}`;
  const tone =
    score >= 80 ? "stroke-emerald-500" : score >= 50 ? "stroke-sky-500" : score >= 25 ? "stroke-amber-500" : "stroke-slate-300";
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

// ─── Lab status rail ──────────────────────────────────────────────

const LAB_STATUS_COPY: Record<
  SimulationLabStatus,
  { label: string; tone: string; dot: string; bg: string; sub: string }
> = {
  idle: {
    label: "Idle",
    tone: "text-slate-700",
    dot: "bg-slate-400",
    bg: "from-slate-50/60 via-white to-white",
    sub: "No active scenario — pick a tier below to start generating synthetic telemetry.",
  },
  warming: {
    label: "Warming",
    tone: "text-sky-700",
    dot: "bg-sky-500",
    bg: "from-sky-50/40 via-white to-white",
    sub: "Light footprint active — basic dashboards receiving signal.",
  },
  active: {
    label: "Active",
    tone: "text-emerald-700",
    dot: "bg-emerald-500",
    bg: "from-emerald-50/50 via-white to-white",
    sub: "Operational scenario running — most dashboards populated with realistic synthetic data.",
  },
  stress: {
    label: "Stress test",
    tone: "text-amber-700",
    dot: "bg-amber-500",
    bg: "from-amber-50/50 via-white to-white",
    sub: "Heavy footprint — full observability surface populated for stress / demo workloads.",
  },
  enterprise: {
    label: "Enterprise",
    tone: "text-violet-700",
    dot: "bg-violet-500",
    bg: "from-violet-50/50 via-white to-white",
    sub: "Maximum simulated load — chaos lab at full scale. All dashboards rendering cross-tenant signal.",
  },
};

function LabStatusBanner({
  kpis,
  enabled,
}: {
  kpis: SimulationMissionKpis;
  enabled: boolean;
}) {
  const s = LAB_STATUS_COPY[kpis.labStatus];
  const pulsing = kpis.labStatus !== "idle";
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
              Lab status: {s.label}
            </span>
            <span className="text-[11px] text-slate-500">
              · tier <span className="font-medium">{kpis.estimatedTier}</span>
              {kpis.totalEntities > 0
                ? ` · ${new Intl.NumberFormat("en-US").format(kpis.totalEntities)} synthetic entities`
                : ""}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{s.sub}</div>
        </div>
      </div>
      {enabled ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
          Lab armed
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-700 ring-1 ring-rose-200">
          <Loader2 className="h-2.5 w-2.5" />
          Lab safed
        </span>
      )}
    </div>
  );
}

// ─── Insight chip ─────────────────────────────────────────────────

const INSIGHT_TONE: Record<
  SimulationInsight["tone"],
  { ring: string; bg: string; text: string; iconColor: string }
> = {
  positive: { ring: "ring-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-900", iconColor: "text-emerald-600" },
  warning: { ring: "ring-amber-200", bg: "bg-amber-50/60", text: "text-amber-900", iconColor: "text-amber-600" },
  info: { ring: "ring-sky-200", bg: "bg-sky-50/60", text: "text-sky-900", iconColor: "text-sky-600" },
  neutral: { ring: "ring-slate-200", bg: "bg-slate-50/60", text: "text-slate-800", iconColor: "text-slate-500" },
};

export function SimulationInsightChip({ insight }: { insight: SimulationInsight }) {
  const t = INSIGHT_TONE[insight.tone];
  const Icon =
    insight.tone === "positive"
      ? TrendingUp
      : insight.tone === "warning"
      ? AlertTriangle
      : insight.tone === "info"
      ? Sparkles
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

export default function SimulationMissionHero({
  kpis,
  insights,
  enabled,
}: {
  kpis: SimulationMissionKpis;
  insights: SimulationInsight[];
  enabled: boolean;
}) {
  const heroInsights = insights.filter((i) => i.surface === "hero");
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <FlaskConical className="h-3 w-3" />
        Chaos lab · controlled synthetic environment · seed-marker safety
      </div>

      <LabStatusBanner kpis={kpis} enabled={enabled} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-7">
        <HeroTile
          label="Simulation intensity"
          value={<AnimatedCounter value={kpis.simulationIntensity} />}
          tone={
            kpis.simulationIntensity >= 80
              ? "critical"
              : kpis.simulationIntensity >= 50
              ? "warning"
              : kpis.simulationIntensity > 0
              ? "primary"
              : "neutral"
          }
          Icon={Gauge}
          detail={
            kpis.simulationIntensity === 0 ? "no synthetic load" : `${kpis.estimatedTier} tier active`
          }
          accessory={<ScoreRing score={kpis.simulationIntensity} />}
        />
        <HeroTile
          label="Realism score"
          value={<AnimatedCounter value={kpis.realismScore} />}
          tone={
            kpis.realismScore >= 90
              ? "growth"
              : kpis.realismScore >= 50
              ? "primary"
              : kpis.realismScore > 0
              ? "warning"
              : "neutral"
          }
          Icon={Radar}
          detail="signal breadth: tenant·user·booking·audit"
          accessory={<ScoreRing score={kpis.realismScore} />}
        />
        <HeroTile
          label="Operational coverage"
          value={
            <>
              <AnimatedCounter value={kpis.operationalCoverage} />
              <span className="ml-0.5 text-[14px] font-medium text-slate-400">%</span>
            </>
          }
          tone={
            kpis.operationalCoverage >= 80
              ? "growth"
              : kpis.operationalCoverage >= 50
              ? "primary"
              : kpis.operationalCoverage > 0
              ? "warning"
              : "neutral"
          }
          Icon={Workflow}
          detail="of admin dashboards populated"
          accessory={<ScoreRing score={kpis.operationalCoverage} />}
        />
        <HeroTile
          label="Footprint health"
          value={<AnimatedCounter value={kpis.syntheticFootprintHealth} />}
          tone={
            kpis.syntheticFootprintHealth >= 95
              ? "growth"
              : kpis.syntheticFootprintHealth >= 75
              ? "primary"
              : "warning"
          }
          Icon={Boxes}
          detail={enabled ? "marker safety intact" : "lab safed — markers tracked"}
          accessory={<ScoreRing score={kpis.syntheticFootprintHealth} />}
        />
        <HeroTile
          label="Telemetry velocity"
          value={<AnimatedCounter value={kpis.telemetryVelocity} />}
          tone={
            kpis.telemetryVelocity >= 100
              ? "growth"
              : kpis.telemetryVelocity >= 30
              ? "primary"
              : kpis.telemetryVelocity > 0
              ? "neutral"
              : "neutral"
          }
          Icon={Zap}
          detail="audit events per tenant"
        />
        <HeroTile
          label="Synthetic load"
          value={<AnimatedCounter value={kpis.syntheticLoadScore} />}
          tone={
            kpis.syntheticLoadScore >= 80
              ? "critical"
              : kpis.syntheticLoadScore >= 50
              ? "warning"
              : kpis.syntheticLoadScore > 0
              ? "primary"
              : "neutral"
          }
          Icon={TrendingUp}
          detail="intensity × velocity composite"
          accessory={<ScoreRing score={kpis.syntheticLoadScore} />}
        />
        <HeroTile
          label="Safety confidence"
          value={<AnimatedCounter value={kpis.safetyConfidence} />}
          tone="growth"
          Icon={ShieldCheck}
          detail="real customer data isolated"
          accessory={<ScoreRing score={kpis.safetyConfidence} />}
        />
      </div>

      {heroInsights.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {heroInsights.map((i) => (
            <SimulationInsightChip key={i.id} insight={i} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
