"use client";

/**
 * Security Mission Control Hero — premium top-of-page operational strip.
 *
 * Seven KPI tiles + threat-level pulse rail + insight chip row. Every
 * value comes from real audit_logs queries (server-computed via the
 * /api/admin/security/mission endpoint). NULL → "—".
 *
 * Tiles:
 *   • Threat level (calm/active/elevated/incident — pulsing rail)
 *   • Security posture (0-100 + ring)
 *   • Auth anomaly score (0-100)
 *   • Suspicious actor velocity (24h)
 *   • OAuth degradation (% with sparkline)
 *   • Impersonations (7d)
 *   • Active investigations (suspicious IPs + multi-IP actors)
 *   • Admin actions (24h + bucket sparkline)
 */

import * as React from "react";
import {
  AlertTriangle,
  Eye,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type {
  SecurityInsight,
  SecurityMissionKpis,
  SecurityThreatLevel,
} from "@/lib/admin-analytics/security-intelligence";

// ─── Sparkline ────────────────────────────────────────────────────

function HeroSparkline({
  data,
  tone = "sky",
  height = 32,
}: {
  data: number[];
  tone?: "sky" | "emerald" | "violet" | "rose" | "amber";
  height?: number;
}) {
  const w = 120;
  const h = height;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  const areaPoints = `0,${h} ${points} ${w},${h}`;
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

// ─── Score ring ───────────────────────────────────────────────────

function ScoreRing({
  score,
  invert,
}: {
  score: number;
  /** If true, higher score = worse (e.g. anomaly). */
  invert?: boolean;
}) {
  const radius = 18;
  const stroke = 3.5;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = `${circ * pct} ${circ}`;
  const tone = invert
    ? score >= 70
      ? "stroke-rose-500"
      : score >= 40
      ? "stroke-amber-500"
      : "stroke-emerald-500"
    : score >= 85
    ? "stroke-emerald-500"
    : score >= 65
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

// ─── Threat-level rail ────────────────────────────────────────────

const THREAT_COPY: Record<
  SecurityThreatLevel,
  { label: string; tone: string; dot: string; bg: string; sub: string }
> = {
  calm: {
    label: "Calm",
    tone: "text-emerald-700",
    dot: "bg-emerald-500",
    bg: "from-emerald-50/50 via-white to-white",
    sub: "No anomalous security patterns detected.",
  },
  active: {
    label: "Active",
    tone: "text-sky-700",
    dot: "bg-sky-500",
    bg: "from-sky-50/40 via-white to-white",
    sub: "Background telemetry above baseline — operations normal.",
  },
  elevated: {
    label: "Elevated",
    tone: "text-amber-700",
    dot: "bg-amber-500",
    bg: "from-amber-50/50 via-white to-white",
    sub: "Multi-signal anomaly detected — review investigations queue.",
  },
  incident: {
    label: "Incident",
    tone: "text-rose-700",
    dot: "bg-rose-500",
    bg: "from-rose-50/60 via-white to-white",
    sub: "Multiple critical signals firing — investigate immediately.",
  },
};

function ThreatLevelBanner({
  kpis,
  liveOn,
}: {
  kpis: SecurityMissionKpis;
  liveOn: boolean;
}) {
  const h = THREAT_COPY[kpis.threatLevel];
  const pulsing = kpis.threatLevel === "incident" || kpis.threatLevel === "elevated";
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-gradient-to-r ${h.bg} px-4 py-3`}
    >
      <div className="flex items-center gap-3">
        <span className="relative inline-flex h-2.5 w-2.5">
          <span
            className={`${pulsing ? "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" : "hidden"} ${h.dot}`}
          />
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${h.dot}`} />
        </span>
        <div>
          <div className="flex items-baseline gap-2">
            <span className={`text-sm font-semibold tracking-tight ${h.tone}`}>
              Threat level: {h.label}
            </span>
            <span className="text-[11px] text-slate-500">
              · {kpis.activeInvestigations} active investigation{kpis.activeInvestigations === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{h.sub}</div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <HeroSparkline
          data={kpis.authFailureBuckets12h}
          tone={
            kpis.threatLevel === "incident"
              ? "rose"
              : kpis.threatLevel === "elevated"
              ? "amber"
              : kpis.threatLevel === "active"
              ? "sky"
              : "emerald"
          }
          height={28}
        />
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
    </div>
  );
}

// ─── Insight chip ─────────────────────────────────────────────────

const INSIGHT_TONE: Record<
  SecurityInsight["tone"],
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

export function SecurityInsightChip({ insight }: { insight: SecurityInsight }) {
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

export default function SecurityMissionHero({
  kpis,
  insights,
  liveOn,
}: {
  kpis: SecurityMissionKpis;
  insights: SecurityInsight[];
  liveOn: boolean;
}) {
  const heroInsights = insights.filter((i) => i.surface === "hero");
  return (
    <section className="space-y-3">
      {/* Eyebrow */}
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span className="inline-flex h-1 w-1 rounded-full bg-emerald-500" />
        Mission control · computed {kpis.computedInMs}ms ago
      </div>

      {/* Threat-level rail */}
      <ThreatLevelBanner kpis={kpis} liveOn={liveOn} />

      {/* KPI grid — 7 tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-7">
        <HeroTile
          label="Security posture"
          value={
            kpis.securityPostureScore === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.securityPostureScore} />
            )
          }
          tone={
            kpis.securityPostureScore === null
              ? "neutral"
              : kpis.securityPostureScore >= 85
              ? "growth"
              : kpis.securityPostureScore >= 65
              ? "warning"
              : "critical"
          }
          Icon={ShieldCheck}
          detail={
            kpis.securityPostureScore === null
              ? "needs ≥20 auth events"
              : "auth + OAuth + IP + ops composite"
          }
          accessory={
            kpis.securityPostureScore !== null ? (
              <ScoreRing score={kpis.securityPostureScore} />
            ) : undefined
          }
        />
        <HeroTile
          label="Auth anomaly score"
          value={
            kpis.authAnomalyScore === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.authAnomalyScore} />
            )
          }
          tone={
            kpis.authAnomalyScore === null
              ? "neutral"
              : kpis.authAnomalyScore >= 70
              ? "critical"
              : kpis.authAnomalyScore >= 40
              ? "warning"
              : "growth"
          }
          Icon={ShieldAlert}
          detail={
            kpis.authAnomalyScore === null
              ? "needs ≥20 auth events"
              : "failure ratio + velocity"
          }
          accessory={
            kpis.authAnomalyScore !== null ? (
              <ScoreRing score={kpis.authAnomalyScore} invert />
            ) : undefined
          }
        />
        <HeroTile
          label="Suspicious actors"
          value={<AnimatedCounter value={kpis.suspiciousActorVelocity} />}
          tone={
            kpis.suspiciousActorVelocity >= 5
              ? "critical"
              : kpis.suspiciousActorVelocity > 0
              ? "warning"
              : "growth"
          }
          Icon={Users}
          detail="≥3 failed logins · 24h"
        />
        <HeroTile
          label="OAuth degradation"
          value={
            kpis.oauthDegradationPct === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <>
                <AnimatedCounter value={kpis.oauthDegradationPct} />
                <span className="ml-0.5 text-[14px] font-medium text-slate-400">%</span>
              </>
            )
          }
          tone={
            kpis.oauthDegradationPct === null
              ? "neutral"
              : kpis.oauthDegradationPct >= 25
              ? "critical"
              : kpis.oauthDegradationPct >= 10
              ? "warning"
              : "growth"
          }
          Icon={KeyRound}
          detail={
            kpis.oauthDegradationPct === null
              ? "needs ≥10 OAuth events"
              : "failures / total OAuth · 24h"
          }
        />
        <HeroTile
          label="Impersonations"
          value={<AnimatedCounter value={kpis.impersonations7d} />}
          tone={
            kpis.impersonations7d >= 10
              ? "warning"
              : kpis.impersonations7d > 0
              ? "neutral"
              : "growth"
          }
          Icon={Eye}
          detail="super-admin overrides · 7d"
        />
        <HeroTile
          label="Active investigations"
          value={<AnimatedCounter value={kpis.activeInvestigations} />}
          tone={
            kpis.activeInvestigations >= 5
              ? "critical"
              : kpis.activeInvestigations > 0
              ? "warning"
              : "growth"
          }
          Icon={AlertTriangle}
          detail="suspicious IPs + multi-IP actors"
        />
        <HeroTile
          label="Admin actions"
          value={<AnimatedCounter value={kpis.adminActions24h} />}
          tone={
            kpis.adminActions24h >= 200
              ? "warning"
              : kpis.adminActions24h > 0
              ? "primary"
              : "neutral"
          }
          Icon={Zap}
          detail="admin.* + permission.* · 24h"
          accessory={
            kpis.adminActionBuckets12h.some((n) => n > 0) ? (
              <HeroSparkline data={kpis.adminActionBuckets12h} tone="violet" />
            ) : undefined
          }
        />
      </div>

      {/* Hero insight chips */}
      {heroInsights.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {heroInsights.map((i) => (
            <SecurityInsightChip key={i.id} insight={i} />
          ))}
        </div>
      ) : null}
    </section>
  );
}
