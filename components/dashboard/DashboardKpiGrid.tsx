/**
 * DashboardKpiGrid — premium icon-led KPI cards with trend indicators.
 *
 * Server component (no client JS). Smooth CSS-only hover transitions.
 * Uses 8 KPIs in a responsive 4-column grid: Today / Upcoming / Revenue
 * / Utilization on row 1, Cancellations / No-show rate / Open tasks /
 * Team on row 2.
 */
import {
  CalendarCheck,
  CalendarClock,
  DollarSign,
  Gauge,
  CalendarX2,
  AlertTriangle,
  ListTodo,
  Users,
  TrendingUp,
  TrendingDown,
  Minus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

type TrendDirection = "up" | "down" | "flat";

type KpiTone = "default" | "positive" | "warning" | "neutral";

type KpiProps = {
  label: string;
  value: string;
  icon: LucideIcon;
  trend?: { direction: TrendDirection; label: string };
  tone?: KpiTone;
  /** When true, the card de-emphasizes itself (lighter background). */
  muted?: boolean;
};

export default function DashboardKpiGrid(props: {
  todayCount: number;
  weekCount: number;
  weekRevenueCents: number;
  utilizationPct: number;
  noShowRatePct: number | null;
  staffCount: number;
  cancellationsCount: number;
  openTasksCount: number;
}) {
  const revenueDisplay = `$${Math.round(props.weekRevenueCents / 100).toLocaleString()}`;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        label="Today's meetings"
        value={String(props.todayCount)}
        icon={CalendarCheck}
        tone={props.todayCount > 0 ? "positive" : "neutral"}
      />
      <Kpi
        label="Upcoming this week"
        value={String(props.weekCount)}
        icon={CalendarClock}
        tone="default"
      />
      <Kpi
        label="Revenue est (week)"
        value={revenueDisplay}
        icon={DollarSign}
        tone={props.weekRevenueCents > 0 ? "positive" : "neutral"}
      />
      <Kpi
        label="Utilization"
        value={`${props.utilizationPct}%`}
        icon={Gauge}
        tone={utilizationTone(props.utilizationPct)}
        trend={utilizationTrend(props.utilizationPct)}
      />

      <Kpi
        label="Cancellations (30d)"
        value={String(props.cancellationsCount)}
        icon={CalendarX2}
        tone={props.cancellationsCount > 5 ? "warning" : "neutral"}
      />
      <Kpi
        label="No-show rate (30d)"
        value={props.noShowRatePct != null ? `${props.noShowRatePct}%` : "—"}
        icon={AlertTriangle}
        tone={noShowTone(props.noShowRatePct)}
      />
      <Kpi
        label="Open tasks"
        value={String(props.openTasksCount)}
        icon={ListTodo}
        tone="neutral"
      />
      <Kpi
        label="Team"
        value={String(props.staffCount)}
        icon={Users}
        tone="neutral"
        muted
      />
    </div>
  );
}

function Kpi(props: KpiProps) {
  const Icon = props.icon;
  const Trend = props.trend
    ? props.trend.direction === "up"
      ? TrendingUp
      : props.trend.direction === "down"
        ? TrendingDown
        : Minus
    : null;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-xs transition-all duration-200",
        "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md",
        props.muted && "bg-surface-subtle"
      )}
    >
      {/* Tonal accent dot in top-right */}
      <div
        aria-hidden
        className={cn(
          "absolute right-5 top-5 inline-flex h-9 w-9 items-center justify-center rounded-xl transition-colors",
          props.tone === "positive" && "bg-emerald-50 text-emerald-600 group-hover:bg-emerald-100",
          props.tone === "warning" && "bg-amber-50 text-amber-600 group-hover:bg-amber-100",
          props.tone === "neutral" && "bg-surface-inset text-ink-subtle",
          (!props.tone || props.tone === "default") && "bg-brand-subtle text-brand-accent group-hover:bg-brand-subtle/80"
        )}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </div>

      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {props.label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <div className="text-3xl font-semibold tracking-tight tabular-nums text-ink">
          {props.value}
        </div>
      </div>

      {props.trend && Trend && (
        <div
          className={cn(
            "mt-3 inline-flex items-center gap-1 text-[11px] font-medium",
            props.trend.direction === "up" && "text-emerald-700",
            props.trend.direction === "down" && "text-red-700",
            props.trend.direction === "flat" && "text-ink-subtle"
          )}
        >
          <Trend className="h-3 w-3" strokeWidth={2} />
          <span>{props.trend.label}</span>
        </div>
      )}
    </div>
  );
}

function utilizationTone(pct: number): KpiTone {
  if (pct >= 80) return "warning";
  if (pct >= 30) return "positive";
  return "neutral";
}

function utilizationTrend(pct: number): KpiProps["trend"] {
  if (pct >= 70) return { direction: "up", label: "Strong week" };
  if (pct >= 30) return { direction: "flat", label: "Healthy pace" };
  if (pct > 0) return { direction: "down", label: "Below capacity" };
  return undefined;
}

function noShowTone(pct: number | null): KpiTone {
  if (pct == null) return "neutral";
  if (pct >= 15) return "warning";
  return "positive";
}
