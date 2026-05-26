"use client";

/**
 * Super-admin KPI card.
 *
 * Premium variant of the dashboard MetricCard — adds:
 *   • Trend delta (% change vs previous period) with up/down/flat
 *     visual treatment.
 *   • Mini inline sparkline (SVG, no external dep) when the KPI
 *     ships a daily series.
 *   • Tooltip on hover explaining the metric definition.
 *   • Loading / error states with graceful fallbacks.
 *
 * Strictly presentational — receives a fully-computed KpiResult.
 * Data source lives in lib/admin-analytics/kpis.ts and the values
 * arrive via the parent server component (or /api/admin/dashboard/kpis
 * for client fetches).
 */

import * as React from "react";
import { TrendingDown, TrendingUp, Minus, Info, AlertCircle } from "lucide-react";

import type { KpiResult } from "@/lib/admin-analytics/kpis";

type Props = {
  label: string;
  result: KpiResult | null;
  tooltip?: string;
  icon?: React.ReactNode;
  /** Override the unit formatter (rare — KpiResult.unit usually suffices) */
  formatOverride?: (v: number) => string;
  /** When true, render a pulsing skeleton instead of values. */
  loading?: boolean;
};

function formatValue(r: KpiResult, override?: (v: number) => string): string {
  if (override && r.value !== null) return override(r.value);
  if (r.value === null) {
    if (r.unit === "string" && r.label) return r.label;
    return "—";
  }
  switch (r.unit) {
    case "currency_cents":
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: r.value >= 100_000 ? 0 : 2,
      }).format(r.value / 100);
    case "percent":
      return `${r.value}%`;
    case "string":
      return r.label ?? "—";
    case "count":
    default:
      return new Intl.NumberFormat("en-US").format(r.value);
  }
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return null;
  const w = 88;
  const h = 28;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = data.length === 1 ? 0 : w / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="text-brand-accent"
      role="img"
      aria-label="14-day trend"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DeltaPill({ deltaPct }: { deltaPct: number | null }) {
  if (deltaPct === null) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-500">
        <Minus className="h-2.5 w-2.5" />
        —
      </span>
    );
  }
  const positive = deltaPct > 0;
  const flat = deltaPct === 0;
  const cls = flat
    ? "bg-slate-100 text-slate-500"
    : positive
    ? "bg-emerald-50 text-emerald-700"
    : "bg-rose-50 text-rose-700";
  const Icon = flat ? Minus : positive ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
      <Icon className="h-2.5 w-2.5" />
      {flat ? "Flat" : `${positive ? "+" : ""}${deltaPct.toFixed(1)}%`}
    </span>
  );
}

export default function KpiCard({ label, result, tooltip, icon, formatOverride, loading }: Props) {
  // ── Loading skeleton ──────────────────────────────────────────
  if (loading || result === null) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex items-center justify-between">
          <div className="h-3 w-20 animate-pulse rounded bg-slate-100" />
          <div className="h-4 w-4 animate-pulse rounded bg-slate-100" />
        </div>
        <div className="mt-3 h-7 w-28 animate-pulse rounded bg-slate-100" />
        <div className="mt-3 h-3 w-16 animate-pulse rounded bg-slate-100" />
      </div>
    );
  }

  // ── Error fallback ────────────────────────────────────────────
  if (result.error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-rose-50/40 p-4">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-rose-700">
          {icon}
          <span>{label}</span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-sm text-rose-700">
          <AlertCircle className="h-3.5 w-3.5" />
          Unable to compute
        </div>
        <div className="mt-1.5 truncate text-[11px] text-rose-600/80" title={result.error}>
          {result.error.slice(0, 60)}
        </div>
      </div>
    );
  }

  const display = formatValue(result, formatOverride);

  return (
    <div className="group relative rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)]">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
          {icon}
          <span>{label}</span>
        </div>
        {tooltip ? (
          <span
            className="relative inline-flex h-4 w-4 cursor-help items-center justify-center text-slate-400 hover:text-slate-600"
            title={tooltip}
          >
            <Info className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex items-baseline gap-2">
        <div className="text-[26px] font-semibold leading-none text-slate-900">{display}</div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <DeltaPill deltaPct={result.deltaPct} />
        {result.sparkline.length >= 2 ? <Sparkline data={result.sparkline} /> : <span />}
      </div>
    </div>
  );
}
