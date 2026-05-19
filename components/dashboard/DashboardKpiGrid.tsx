/**
 * DashboardKpiGrid (Phase 2) — financial-grade KPI tiles.
 *
 * Uses the shared MetricCard primitive so every metric tile across the
 * platform shares one visual language. Adds tiny SVG sparkline
 * placeholders for the metrics where a trend over time is meaningful;
 * the sparkline component is intentionally simple (no Recharts) — it's
 * a presentation accent, not data viz. Real charts ship in Phase 3.
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
} from "lucide-react";
import { MetricCard, type MetricTone } from "@/components/ui/Card";

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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        label="Today's meetings"
        value={props.todayCount}
        icon={CalendarCheck}
        tone={props.todayCount > 0 ? "positive" : "neutral"}
        sparkline={
          <Sparkline
            data={syntheticSeries(props.todayCount, props.weekCount)}
            tone={props.todayCount > 0 ? "positive" : "neutral"}
          />
        }
      />
      <MetricCard
        label="Upcoming this week"
        value={props.weekCount}
        icon={CalendarClock}
        tone="brand"
        sparkline={<Sparkline data={syntheticSeries(props.weekCount, props.weekCount * 1.2)} tone="brand" />}
      />
      <MetricCard
        label="Revenue est (week)"
        value={revenueDisplay}
        icon={DollarSign}
        tone={props.weekRevenueCents > 0 ? "positive" : "neutral"}
        sparkline={
          <Sparkline
            data={syntheticSeries(Math.round(props.weekRevenueCents / 100), Math.round(props.weekRevenueCents / 100) * 1.3)}
            tone={props.weekRevenueCents > 0 ? "positive" : "neutral"}
          />
        }
      />
      <MetricCard
        label="Utilization"
        value={`${props.utilizationPct}%`}
        icon={Gauge}
        tone={utilizationTone(props.utilizationPct)}
        trend={utilizationTrend(props.utilizationPct)}
      />

      <MetricCard
        label="Cancellations (30d)"
        value={props.cancellationsCount}
        icon={CalendarX2}
        tone={props.cancellationsCount > 5 ? "warning" : "neutral"}
      />
      <MetricCard
        label="No-show rate (30d)"
        value={props.noShowRatePct != null ? `${props.noShowRatePct}%` : "—"}
        icon={AlertTriangle}
        tone={noShowTone(props.noShowRatePct)}
      />
      <MetricCard
        label="Open tasks"
        value={props.openTasksCount}
        icon={ListTodo}
        tone="neutral"
      />
      <MetricCard
        label="Team"
        value={props.staffCount}
        icon={Users}
        tone="neutral"
        muted
      />
    </div>
  );
}

// ─── Sparkline (pure SVG — accent only, not data viz) ───────────────

function Sparkline({
  data,
  tone,
}: {
  data: number[];
  tone: MetricTone;
}) {
  const w = 90;
  const h = 26;
  if (data.length < 2) {
    // Flat baseline — keeps card height stable in empty states.
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
        <line
          x1="0"
          y1={h - 4}
          x2={w}
          y2={h - 4}
          stroke="currentColor"
          strokeWidth="1.25"
          strokeDasharray="3 3"
          className="text-ink-subtle/40"
        />
      </svg>
    );
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = Math.max(1, max - min);
  const stepX = w / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = h - 4 - ((v - min) / range) * (h - 8);
      return `${x},${y}`;
    })
    .join(" ");

  const stroke =
    tone === "positive"
      ? "stroke-emerald-500"
      : tone === "warning"
        ? "stroke-amber-500"
        : tone === "neutral"
          ? "stroke-ink-subtle"
          : "stroke-brand-accent";

  const fill =
    tone === "positive"
      ? "fill-emerald-500/15"
      : tone === "warning"
        ? "fill-amber-500/15"
        : tone === "neutral"
          ? "fill-ink-subtle/10"
          : "fill-brand-accent/15";

  // Area under the line — anchor to bottom corners
  const areaPoints = `0,${h} ${points} ${w},${h}`;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <polygon points={areaPoints} className={fill} />
      <polyline
        points={points}
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={stroke}
      />
    </svg>
  );
}

/** Deterministic-but-visually-pleasing 7-point series derived from
 *  the current + previous metric values. NOT real historical data —
 *  this is a visual accent that hints at trend without lying about
 *  history. Real per-day series will replace this when the analytics
 *  daily snapshots query feeds back in Phase 3. */
function syntheticSeries(current: number, previous: number): number[] {
  const c = Number.isFinite(current) ? current : 0;
  const p = Number.isFinite(previous) ? previous : 0;
  if (c === 0 && p === 0) return [0, 0, 0, 0, 0, 0, 0];
  // Smooth interpolation from previous→current with a small wiggle
  // seeded by the values themselves (deterministic, no randomness).
  const out: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = i / 6;
    const base = p + (c - p) * t;
    const wobble = ((Math.sin((i + c + p) * 1.7) + 1) / 2) * Math.max(1, Math.abs(c - p)) * 0.18;
    out.push(Math.max(0, base + wobble));
  }
  return out;
}

function utilizationTone(pct: number): MetricTone {
  if (pct >= 80) return "warning";
  if (pct >= 30) return "positive";
  return "neutral";
}

function utilizationTrend(pct: number) {
  if (pct >= 70) return { direction: "up" as const, label: "Strong" };
  if (pct >= 30) return { direction: "flat" as const, label: "Healthy" };
  if (pct > 0) return { direction: "down" as const, label: "Below capacity" };
  return undefined;
}

function noShowTone(pct: number | null): MetricTone {
  if (pct == null) return "neutral";
  if (pct >= 15) return "warning";
  return "positive";
}
