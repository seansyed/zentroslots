"use client";

/**
 * Activity Mission Control Hero — premium top-of-page operational strip.
 *
 * Eight executive-grade KPI tiles + throughput sparkline + a pulsing
 * stream-health indicator. Every value comes from real audit_logs
 * queries; NULL renders "—" rather than fabricating a 0.
 *
 * Tiles:
 *   • Active incidents (24h)
 *   • Warnings (24h)
 *   • Auth failures (24h)
 *   • OAuth failures (24h)
 *   • Webhook degradation
 *   • Impersonations (24h)
 *   • Anomaly score (with severity ring)
 *   • Live throughput (events/hr + sparkline)
 *
 * The hero also surfaces a pulsing health rail across the top — calm,
 * active, elevated, or incident — derived deterministically from the
 * underlying counts.
 */

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  CreditCard,
  Eye,
  KeyRound,
  Loader2,
  Shield,
  ShieldAlert,
  TrendingUp,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type { ActivityMissionKpis } from "@/lib/admin-analytics/activity-presets";

// ─── Throughput sparkline (SVG) ───────────────────────────────────

function ThroughputSparkline({
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

// ─── Anomaly score ring ───────────────────────────────────────────

function AnomalyRing({ score }: { score: number }) {
  const radius = 18;
  const stroke = 3.5;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dash = `${circ * pct} ${circ}`;
  const tone =
    score >= 70 ? "stroke-rose-500" : score >= 40 ? "stroke-amber-500" : "stroke-emerald-500";
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

// ─── Stream health pulse rail ─────────────────────────────────────

const HEALTH_COPY: Record<
  ActivityMissionKpis["streamHealth"],
  { label: string; tone: string; dot: string; bg: string }
> = {
  calm: {
    label: "Calm",
    tone: "text-emerald-700",
    dot: "bg-emerald-500",
    bg: "from-emerald-50/40 via-white to-white",
  },
  active: {
    label: "Active",
    tone: "text-sky-700",
    dot: "bg-sky-500",
    bg: "from-sky-50/40 via-white to-white",
  },
  elevated: {
    label: "Elevated",
    tone: "text-amber-700",
    dot: "bg-amber-500",
    bg: "from-amber-50/40 via-white to-white",
  },
  incident: {
    label: "Incident",
    tone: "text-rose-700",
    dot: "bg-rose-500",
    bg: "from-rose-50/60 via-white to-white",
  },
};

function StreamHealthBanner({
  kpis,
  liveOn,
}: {
  kpis: ActivityMissionKpis;
  liveOn: boolean;
}) {
  const h = HEALTH_COPY[kpis.streamHealth];
  const pulsing = kpis.streamHealth === "incident" || kpis.streamHealth === "elevated";
  return (
    <div
      className={`flex items-center justify-between rounded-2xl border border-slate-200 bg-gradient-to-r ${h.bg} px-4 py-3`}
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
              Stream {h.label}
            </span>
            <span className="text-[11px] text-slate-500">
              · {kpis.eventsLastHour} events/hr (baseline {kpis.baselineEventsPerHour}/hr)
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            {kpis.streamHealth === "incident"
              ? "Multiple failure classes elevated — investigate immediately."
              : kpis.streamHealth === "elevated"
              ? "Throughput or failure ratio above baseline — review anomalies."
              : kpis.streamHealth === "active"
              ? "Throughput above typical hourly rate — operations normal."
              : "Operations nominal — no anomalous patterns detected."}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <ThroughputSparkline
          data={kpis.throughput12h}
          tone={
            kpis.streamHealth === "incident"
              ? "rose"
              : kpis.streamHealth === "elevated"
              ? "amber"
              : kpis.streamHealth === "active"
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

// ─── Hero ─────────────────────────────────────────────────────────

export default function ActivityMissionHero({
  kpis,
  liveOn,
}: {
  kpis: ActivityMissionKpis;
  liveOn: boolean;
}) {
  return (
    <section className="space-y-3">
      {/* Eyebrow */}
      <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.12em] text-slate-500">
        <span className="inline-flex h-1 w-1 rounded-full bg-emerald-500" />
        Mission control · computed {kpis.computedInMs}ms ago
      </div>

      {/* Stream health rail */}
      <StreamHealthBanner kpis={kpis} liveOn={liveOn} />

      {/* KPI grid — 8 tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-8">
        <HeroTile
          label="Active incidents"
          value={<AnimatedCounter value={kpis.activeIncidents24h} />}
          tone={kpis.activeIncidents24h >= 10 ? "critical" : kpis.activeIncidents24h > 0 ? "warning" : "growth"}
          Icon={AlertTriangle}
          detail="failures · suspensions · errors · 24h"
        />
        <HeroTile
          label="Warnings"
          value={<AnimatedCounter value={kpis.warnings24h} />}
          tone={kpis.warnings24h > 0 ? "warning" : "neutral"}
          Icon={ShieldAlert}
          detail="non-critical anomalies · 24h"
        />
        <HeroTile
          label="Auth failures"
          value={<AnimatedCounter value={kpis.authFailures24h} />}
          tone={kpis.authFailures24h >= 20 ? "critical" : kpis.authFailures24h > 0 ? "warning" : "growth"}
          Icon={Shield}
          detail="login_failure + suspicious"
        />
        <HeroTile
          label="OAuth failures"
          value={<AnimatedCounter value={kpis.oauthFailures24h} />}
          tone={kpis.oauthFailures24h >= 10 ? "critical" : kpis.oauthFailures24h > 0 ? "warning" : "neutral"}
          Icon={KeyRound}
          detail="oauth + calendar sync · 24h"
        />
        <HeroTile
          label="Webhook degradation"
          value={<AnimatedCounter value={kpis.webhookFailures24h} />}
          tone={kpis.webhookFailures24h >= 5 ? "critical" : kpis.webhookFailures24h > 0 ? "warning" : "neutral"}
          Icon={Bell}
          detail="webhook delivery failures · 24h"
        />
        <HeroTile
          label="Impersonations"
          value={<AnimatedCounter value={kpis.impersonations24h} />}
          tone={kpis.impersonations24h > 3 ? "warning" : "neutral"}
          Icon={Eye}
          detail="super-admin overrides · 24h"
        />
        <HeroTile
          label="Anomaly score"
          value={
            kpis.anomalyScore === null ? (
              <span className="text-slate-400">—</span>
            ) : (
              <AnimatedCounter value={kpis.anomalyScore} />
            )
          }
          tone={
            kpis.anomalyScore === null
              ? "neutral"
              : kpis.anomalyScore >= 70
              ? "critical"
              : kpis.anomalyScore >= 40
              ? "warning"
              : "growth"
          }
          Icon={Zap}
          detail={
            kpis.anomalyScore === null
              ? "needs ≥50 events"
              : kpis.anomalyScore >= 70
              ? "incident-tier signal"
              : kpis.anomalyScore >= 40
              ? "elevated signal"
              : "nominal signal"
          }
          accessory={
            kpis.anomalyScore !== null ? <AnomalyRing score={kpis.anomalyScore} /> : undefined
          }
        />
        <HeroTile
          label="Throughput"
          value={
            <span>
              <AnimatedCounter value={kpis.eventsLastHour} />
              <span className="ml-1 text-[12px] font-medium text-slate-400">/hr</span>
            </span>
          }
          tone={kpis.eventsLastHour >= kpis.baselineEventsPerHour * 2 ? "warning" : "primary"}
          Icon={TrendingUp}
          detail={`baseline ${kpis.baselineEventsPerHour}/hr · 24h avg`}
          accessory={
            <ThroughputSparkline
              data={kpis.throughput12h}
              tone={
                kpis.eventsLastHour >= kpis.baselineEventsPerHour * 2
                  ? "amber"
                  : kpis.eventsLastHour > kpis.baselineEventsPerHour
                  ? "sky"
                  : "emerald"
              }
            />
          }
        />
      </div>
    </section>
  );
}
