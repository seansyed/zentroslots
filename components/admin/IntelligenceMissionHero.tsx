"use client";

/**
 * Operations Intelligence Executive Hero — premium top-of-page strategic
 * intelligence strip. Every score is a deterministic composite of insights
 * already produced by the SQL rules engine. NULL → "—".
 *
 * Seven KPI tiles + platform-posture rail + insight chip row:
 *   • Platform health (SVG ring, higher = better)
 *   • Growth momentum (SVG ring)
 *   • Churn pressure (SVG ring, higher = WORSE)
 *   • Financial confidence (SVG ring)
 *   • Onboarding velocity (SVG ring)
 *   • Operational anomaly (SVG ring, higher = WORSE)
 *   • Strategic opportunity (SVG ring, higher = better)
 *
 * Pulse rail shows overall posture: calm / elevated / incident.
 */

import * as React from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Brain,
  CreditCard,
  Database,
  Heart,
  Loader2,
  Sparkles,
  TrendingUp,
  UserMinus,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type {
  IntelligenceMissionKpis,
  IntelligenceMissionTone,
} from "@/lib/admin-analytics/intelligence-mission";

// ─── Score ring ───────────────────────────────────────────────────

function ScoreRing({
  score,
  invert,
}: {
  score: number;
  /** If true, higher = worse (red). */
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
    : score >= 50
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

// ─── Posture rail ─────────────────────────────────────────────────

const POSTURE_COPY: Record<
  IntelligenceMissionTone,
  { label: string; tone: string; dot: string; bg: string; sub: string }
> = {
  calm: {
    label: "Stable",
    tone: "text-emerald-700",
    dot: "bg-emerald-500",
    bg: "from-emerald-50/50 via-white to-white",
    sub: "No critical signals. Rules engine quiet across infrastructure, churn, and finance.",
  },
  elevated: {
    label: "Elevated",
    tone: "text-amber-700",
    dot: "bg-amber-500",
    bg: "from-amber-50/50 via-white to-white",
    sub: "Multi-rule warnings present — review affected categories below.",
  },
  incident: {
    label: "Incident",
    tone: "text-rose-700",
    dot: "bg-rose-500",
    bg: "from-rose-50/60 via-white to-white",
    sub: "Critical signals firing — strategic + operational review needed immediately.",
  },
};

function PostureBanner({ kpis }: { kpis: IntelligenceMissionKpis }) {
  const p = POSTURE_COPY[kpis.platformPosture];
  const pulsing = kpis.platformPosture !== "calm";
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
              Platform posture: {p.label}
            </span>
            <span className="text-[11px] text-slate-500">
              · {kpis.criticalCount} critical · {kpis.warningCount} warning · {kpis.opportunityCount} opportunity
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{p.sub}</div>
        </div>
      </div>
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-700">
        <Brain className="h-2.5 w-2.5" />
        Deterministic rules
      </span>
    </div>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────

export default function IntelligenceMissionHero({
  kpis,
  computedInMs,
}: {
  kpis: IntelligenceMissionKpis;
  computedInMs: number;
}) {
  return (
    <section className="space-y-3">
      {/* Eyebrow */}
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span className="inline-flex h-1 w-1 rounded-full bg-emerald-500" />
        Executive intelligence · computed {computedInMs}ms ago
      </div>

      {/* Platform posture rail */}
      <PostureBanner kpis={kpis} />

      {/* KPI grid — 7 tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-7">
        <HeroTile
          label="Platform health"
          value={
            kpis.platformHealth === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.platformHealth} />
            )
          }
          tone={
            kpis.platformHealth === null
              ? "neutral"
              : kpis.platformHealth >= 80
              ? "growth"
              : kpis.platformHealth >= 60
              ? "warning"
              : "critical"
          }
          Icon={Heart}
          detail="infra + security signal absence"
          accessory={
            kpis.platformHealth !== null ? <ScoreRing score={kpis.platformHealth} /> : undefined
          }
        />
        <HeroTile
          label="Growth momentum"
          value={
            kpis.growthMomentum === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.growthMomentum} />
            )
          }
          tone={
            kpis.growthMomentum === null
              ? "neutral"
              : kpis.growthMomentum >= 70
              ? "growth"
              : kpis.growthMomentum >= 40
              ? "primary"
              : "warning"
          }
          Icon={TrendingUp}
          detail={
            kpis.growthMomentum === null
              ? "no growth/churn signals"
              : "growth signals − churn drag"
          }
          accessory={
            kpis.growthMomentum !== null ? <ScoreRing score={kpis.growthMomentum} /> : undefined
          }
        />
        <HeroTile
          label="Churn pressure"
          value={
            kpis.churnPressure === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.churnPressure} />
            )
          }
          tone={
            kpis.churnPressure === null
              ? "neutral"
              : kpis.churnPressure >= 40
              ? "critical"
              : kpis.churnPressure >= 20
              ? "warning"
              : "growth"
          }
          Icon={UserMinus}
          detail={
            kpis.churnPressure === 0
              ? "no churn signals"
              : "churn + onboarding-dropoff weight"
          }
          accessory={
            kpis.churnPressure !== null ? <ScoreRing score={kpis.churnPressure} invert /> : undefined
          }
        />
        <HeroTile
          label="Financial confidence"
          value={
            kpis.financialConfidence === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.financialConfidence} />
            )
          }
          tone={
            kpis.financialConfidence === null
              ? "neutral"
              : kpis.financialConfidence >= 85
              ? "growth"
              : kpis.financialConfidence >= 60
              ? "warning"
              : "critical"
          }
          Icon={CreditCard}
          detail="recovery drag + upgrade bonus"
          accessory={
            kpis.financialConfidence !== null ? (
              <ScoreRing score={kpis.financialConfidence} />
            ) : undefined
          }
        />
        <HeroTile
          label="Onboarding velocity"
          value={
            kpis.onboardingVelocity === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.onboardingVelocity} />
            )
          }
          tone={
            kpis.onboardingVelocity === null
              ? "neutral"
              : kpis.onboardingVelocity >= 70
              ? "growth"
              : kpis.onboardingVelocity >= 40
              ? "primary"
              : "warning"
          }
          Icon={Sparkles}
          detail={
            kpis.onboardingVelocity === null
              ? "no conversion / dropoff data"
              : "activation rate − dropoff drag"
          }
          accessory={
            kpis.onboardingVelocity !== null ? (
              <ScoreRing score={kpis.onboardingVelocity} />
            ) : undefined
          }
        />
        <HeroTile
          label="Operational anomaly"
          value={
            kpis.operationalAnomaly === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.operationalAnomaly} />
            )
          }
          tone={
            kpis.operationalAnomaly === null
              ? "neutral"
              : kpis.operationalAnomaly >= 40
              ? "critical"
              : kpis.operationalAnomaly >= 20
              ? "warning"
              : "growth"
          }
          Icon={Database}
          detail={
            kpis.operationalAnomaly === 0
              ? "no operational signals"
              : "infra + ops severity weight"
          }
          accessory={
            kpis.operationalAnomaly !== null ? (
              <ScoreRing score={kpis.operationalAnomaly} invert />
            ) : undefined
          }
        />
        <HeroTile
          label="Strategic opportunity"
          value={
            kpis.strategicOpportunity === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.strategicOpportunity} />
            )
          }
          tone={
            kpis.strategicOpportunity === null
              ? "neutral"
              : kpis.strategicOpportunity >= 50
              ? "growth"
              : kpis.strategicOpportunity >= 25
              ? "primary"
              : "neutral"
          }
          Icon={ArrowUpRight}
          detail={
            kpis.strategicOpportunity === null
              ? "no opportunity signals"
              : "opportunity + upgrade + high-growth"
          }
          accessory={
            kpis.strategicOpportunity !== null ? (
              <ScoreRing score={kpis.strategicOpportunity} />
            ) : undefined
          }
        />
      </div>
    </section>
  );
}
