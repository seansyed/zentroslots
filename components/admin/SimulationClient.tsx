"use client";

/**
 * Simulation Control Center — Enterprise Chaos Lab.
 *
 * Premium chaos-engineering experience built on top of the existing
 * triple-gated synthetic seeding system:
 *
 *   • Super-admin only (route gate)
 *   • ALLOW_DEV_SIMULATION env (lib boundary)
 *   • Every seeded row carries SEEDED_BY_MARKER for safe reset
 *
 * NEVER touches real customer data. Every score, chip, and visualization
 * on this page operates on the synthetic footprint summary returned by
 * getSimulationStatus(). No new SQL. No real-data reads.
 *
 * Premium UX layers:
 *   • SimulationMissionHero — 7 composite KPIs + lab-status pulse rail
 *   • Premium scenario tier cards (Light / Medium / Heavy / Enterprise)
 *     with intensity bars, blast-radius previews
 *   • Premium injector cards with category icons + propagation paths
 *   • Archetype gallery with growth-curve visualization
 *   • Scenario drilldown drawer with cleanup verification
 *   • Safety validation strip
 */

import * as React from "react";
import { confirmAction } from "@/components/ui/primitives";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  Database,
  FlaskConical,
  KeyRound,
  Loader2,
  Lock,
  Play,
  RefreshCw,
  Shield,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Trash2,
  Workflow,
  X,
  Zap,
} from "lucide-react";

import { ARCHETYPES, type Archetype } from "@/lib/dev-seeding/archetypes";
import {
  deriveSimulationInsights,
  deriveSimulationMission,
  INJECTOR_META,
  SCENARIO_TIERS,
  type InjectorMeta,
  type ScenarioTier,
  type SimulationFootprint,
} from "@/lib/dev-seeding/simulation-mission";
import SimulationMissionHero, {
  SimulationInsightChip,
} from "@/components/admin/SimulationMissionHero";

type StatusResp = {
  enabled: boolean;
  status: SimulationFootprint;
};

// ─── Tone tokens ──────────────────────────────────────────────────

const TIER_TONE: Record<
  ScenarioTier["tone"],
  {
    ring: string;
    bg: string;
    rail: string;
    accent: string;
    bar: string;
    label: string;
  }
> = {
  info: {
    ring: "border-sky-200",
    bg: "from-white via-sky-50/30 to-sky-50/60",
    rail: "before:bg-sky-400/60",
    accent: "text-sky-700",
    bar: "bg-sky-500",
    label: "Light",
  },
  primary: {
    ring: "border-emerald-200",
    bg: "from-white via-emerald-50/30 to-emerald-50/60",
    rail: "before:bg-emerald-400/70",
    accent: "text-emerald-700",
    bar: "bg-emerald-500",
    label: "Medium",
  },
  warning: {
    ring: "border-amber-200",
    bg: "from-white via-amber-50/30 to-amber-50/60",
    rail: "before:bg-amber-400/70",
    accent: "text-amber-700",
    bar: "bg-amber-500",
    label: "Heavy",
  },
  critical: {
    ring: "border-violet-200 shadow-[0_0_0_1px_rgba(139,92,246,0.06)]",
    bg: "from-white via-violet-50/40 to-violet-50/70",
    rail: "before:bg-violet-500/80",
    accent: "text-violet-700",
    bar: "bg-violet-500",
    label: "Enterprise",
  },
};

const INJECTOR_CATEGORY: Record<
  InjectorMeta["category"],
  { Icon: React.ComponentType<{ className?: string }>; bg: string; iconColor: string; ring: string; bar: string }
> = {
  churn: {
    Icon: TrendingUp,
    bg: "bg-rose-50",
    iconColor: "text-rose-600",
    ring: "ring-rose-200",
    bar: "bg-rose-500",
  },
  growth: {
    Icon: Sparkles,
    bg: "bg-emerald-50",
    iconColor: "text-emerald-600",
    ring: "ring-emerald-200",
    bar: "bg-emerald-500",
  },
  delivery: {
    Icon: Zap,
    bg: "bg-amber-50",
    iconColor: "text-amber-600",
    ring: "ring-amber-200",
    bar: "bg-amber-500",
  },
  integration: {
    Icon: KeyRound,
    bg: "bg-sky-50",
    iconColor: "text-sky-600",
    ring: "ring-sky-200",
    bar: "bg-sky-500",
  },
  infrastructure: {
    Icon: Database,
    bg: "bg-violet-50",
    iconColor: "text-violet-600",
    ring: "ring-violet-200",
    bar: "bg-violet-500",
  },
};

const ARCHETYPE_GROWTH_VISUAL: Record<
  Archetype["growth"],
  { tone: string; sparkline: number[]; label: string }
> = {
  flat: {
    tone: "stroke-slate-400",
    sparkline: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    label: "Flat",
  },
  climbing: {
    tone: "stroke-emerald-500",
    sparkline: [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.78, 0.85, 0.92, 1.0, 1.08, 1.15],
    label: "Climbing",
  },
  declining: {
    tone: "stroke-rose-500",
    sparkline: [1.2, 1.15, 1.1, 1.05, 1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6],
    label: "Declining",
  },
  seasonal: {
    tone: "stroke-violet-500",
    sparkline: [0.6, 0.65, 0.7, 0.85, 1.0, 1.2, 1.4, 1.5, 1.4, 1.1, 0.8, 0.65],
    label: "Seasonal",
  },
};

function ArchetypeSparkline({ data, tone }: { data: number[]; tone: string }) {
  const w = 100;
  const h = 22;
  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={tone}
      />
    </svg>
  );
}

// ─── Scenario tier card ───────────────────────────────────────────

function ScenarioTierCard({
  tier,
  busy,
  enabled,
  onRun,
}: {
  tier: ScenarioTier;
  busy: string | null;
  enabled: boolean;
  onRun: (tierId: string) => void;
}) {
  const tone = TIER_TONE[tier.tone];
  const isBusy = busy === `run:${tier.id}`;
  return (
    <button
      type="button"
      disabled={!enabled || busy !== null}
      onClick={() => onRun(tier.id)}
      className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-4 pl-5 text-left shadow-[0_1px_3px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-[0_1px_3px_rgba(15,23,42,0.04)] before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${tone.ring} ${tone.bg} ${tone.rail}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone.accent} ring-1 ${tone.ring.replace("border-", "ring-")}`}>
          {tier.label}
        </span>
        {isBusy ? (
          <Loader2 className={`h-3.5 w-3.5 animate-spin ${tone.accent}`} />
        ) : (
          <Play className={`h-4 w-4 ${tone.accent}`} />
        )}
      </div>
      <div className="mt-2 text-[18px] font-semibold tracking-tight text-slate-900">
        {tier.tenantCount} tenants
      </div>
      <div className="text-[11px] text-slate-500">{tier.historyDays}d synthetic history</div>

      {/* Intensity bar */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-slate-500">
          <span>Intensity</span>
          <span className="tabular-nums">{tier.intensityPct}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full ${tone.bar} transition-all duration-700`}
            style={{ width: `${tier.intensityPct}%` }}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11px] text-slate-500">
        <span>~{new Intl.NumberFormat("en-US").format(tier.eventVolumeEstimate)} events</span>
        <span className="opacity-0 transition-opacity group-hover:opacity-100">
          <ChevronRight className="h-3 w-3" />
        </span>
      </div>
    </button>
  );
}

// ─── Injector card ────────────────────────────────────────────────

function InjectorCard({
  injector,
  busy,
  disabled,
  onInject,
  onOpen,
}: {
  injector: InjectorMeta;
  busy: string | null;
  disabled: boolean;
  onInject: (kind: string) => void;
  onOpen: (i: InjectorMeta) => void;
}) {
  const cat = INJECTOR_CATEGORY[injector.category];
  const isBusy = busy === `inject:${injector.id}`;
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-slate-50/30 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_18px_rgba(15,23,42,0.06)] ${disabled ? "opacity-50" : ""}`}
    >
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${cat.bg} ${cat.ring}`}>
          <cat.Icon className={`h-4 w-4 ${cat.iconColor}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold tracking-tight text-slate-900">
              {injector.label}
            </span>
            <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${cat.bg} ${cat.iconColor} ${cat.ring}`}>
              {injector.category}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">{injector.detail}</div>
        </div>
      </div>

      {/* Intensity bar */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-slate-500">
          <span>Blast intensity</span>
          <span className="tabular-nums">{injector.intensityPct}%</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full ${cat.bar} transition-all duration-700`}
            style={{ width: `${injector.intensityPct}%` }}
          />
        </div>
      </div>

      {/* Blast radius */}
      <div className="mt-2.5">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">Affects</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {injector.blastRadius.map((d) => (
            <span
              key={d}
              className="inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
            >
              {d}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={disabled || busy !== null}
          onClick={() => onInject(injector.id)}
          className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-white shadow-sm transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 ${cat.bar} hover:brightness-110`}
        >
          {isBusy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Zap className="h-3 w-3" />
          )}
          Inject
        </button>
        <button
          type="button"
          onClick={() => onOpen(injector)}
          className="inline-flex items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
        >
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Archetype card ───────────────────────────────────────────────

function ArchetypeCard({ a }: { a: Archetype }) {
  const growth = ARCHETYPE_GROWTH_VISUAL[a.growth];
  const churnTone =
    a.churnMultiplier < 0.8
      ? "text-emerald-700 bg-emerald-50"
      : a.churnMultiplier <= 1.1
      ? "text-slate-700 bg-slate-100"
      : "text-amber-700 bg-amber-50";
  return (
    <div className="group relative overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50/30 p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_12px_rgba(15,23,42,0.05)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold tracking-tight text-slate-900">{a.label}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
            <span className="tabular-nums">{a.bookingsPerDay.mean}/day</span>
            <span>·</span>
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${churnTone}`}>
              {a.churnMultiplier < 0.8 ? "low churn" : a.churnMultiplier <= 1.1 ? "avg churn" : "high churn"}
            </span>
          </div>
        </div>
        <span className={`shrink-0 text-[9px] font-medium uppercase tracking-wider ${a.growth === "climbing" ? "text-emerald-700" : a.growth === "declining" ? "text-rose-700" : a.growth === "seasonal" ? "text-violet-700" : "text-slate-500"}`}>
          {growth.label}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-slate-500">
        <span>
          {a.staff.min}–{a.staff.max} staff
        </span>
        <ArchetypeSparkline data={growth.sparkline} tone={growth.tone} />
      </div>
    </div>
  );
}

// ─── Footprint card ───────────────────────────────────────────────

function FootprintCard({
  label,
  count,
  Icon,
  tone,
}: {
  label: string;
  count: number;
  Icon: React.ComponentType<{ className?: string }>;
  tone: "sky" | "violet" | "emerald" | "amber";
}) {
  const tones = {
    sky: { bg: "bg-sky-50", iconColor: "text-sky-600", ring: "ring-sky-200" },
    violet: { bg: "bg-violet-50", iconColor: "text-violet-600", ring: "ring-violet-200" },
    emerald: { bg: "bg-emerald-50", iconColor: "text-emerald-600", ring: "ring-emerald-200" },
    amber: { bg: "bg-amber-50", iconColor: "text-amber-600", ring: "ring-amber-200" },
  } as const;
  const t = tones[tone];
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-100 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${t.bg} ${t.ring}`}>
        <Icon className={`h-4 w-4 ${t.iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
        <div
          className="text-[20px] font-semibold leading-none text-slate-900"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {new Intl.NumberFormat("en-US").format(count)}
        </div>
      </div>
    </div>
  );
}

// ─── Investigation drawer (injector detail) ───────────────────────

function InjectorDrawer({
  injector,
  onClose,
  enabled,
  busy,
  onInject,
}: {
  injector: InjectorMeta | null;
  onClose: () => void;
  enabled: boolean;
  busy: string | null;
  onInject: (kind: string) => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!injector) return null;
  const cat = INJECTOR_CATEGORY[injector.category];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl animate-[slideInDrawer_220ms_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-gradient-to-br from-slate-50/80 via-white to-white px-6 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${cat.bg} ${cat.iconColor} ${cat.ring}`}
                >
                  <cat.Icon className="h-2.5 w-2.5" />
                  {injector.category}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-700">
                  injector
                </span>
              </div>
              <h2 className="mt-2 text-base font-semibold tracking-tight text-slate-900">
                {injector.label}
              </h2>
              <div className="mt-1 text-[12px] text-slate-500">{injector.detail}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="space-y-5 px-6 py-5">
          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Blast intensity
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full ${cat.bar} transition-all duration-700`} style={{ width: `${injector.intensityPct}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              {injector.intensityPct}% intensity · operates only on SEEDED tenants
            </div>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Propagation paths
            </div>
            <ul className="space-y-1.5 text-[12px] text-slate-700">
              {injector.blastRadius.map((dash) => (
                <li key={dash} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/30 px-3 py-2">
                  <Workflow className="h-3 w-3 shrink-0 text-slate-400" />
                  <span>
                    Telemetry will surface on <code className="text-[11px] font-semibold">/admin/{dash}</code>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Safety guarantees
            </div>
            <ul className="space-y-1.5 text-[12px] text-slate-700">
              <li className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/30 px-3 py-2">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>Targets only tenants tagged with SEEDED_BY_MARKER</span>
              </li>
              <li className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/30 px-3 py-2">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>All injected rows carry the same marker — Reset wipes them cleanly</span>
              </li>
              <li className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/30 px-3 py-2">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                <span>Real customer data is never read or mutated by this injector</span>
              </li>
            </ul>
          </section>

          <section>
            <button
              type="button"
              disabled={!enabled || busy !== null}
              onClick={() => {
                onInject(injector.id);
                onClose();
              }}
              className={`inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm transition-all hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 ${cat.bar} hover:brightness-110`}
            >
              {busy === `inject:${injector.id}` ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Zap className="h-3.5 w-3.5" />
              )}
              Inject &ldquo;{injector.label}&rdquo;
            </button>
          </section>
        </div>
      </aside>
    </div>
  );
}

// ─── Safety validation strip ──────────────────────────────────────

function SafetyValidationStrip({ enabled, status }: { enabled: boolean; status: SimulationFootprint }) {
  const items: Array<{ Icon: React.ComponentType<{ className?: string }>; label: string; detail: string; tone: "emerald" | "amber" }> = [
    {
      Icon: ShieldCheck,
      label: "Real customer data isolated",
      detail: "Operations target SEEDED rows only · marker enforced at lib boundary",
      tone: "emerald",
    },
    {
      Icon: Lock,
      label: enabled ? "Triple-gated arming intact" : "Lab safed by env flag",
      detail: enabled
        ? "Super-admin · ALLOW_DEV_SIMULATION · marker pattern all satisfied"
        : "ALLOW_DEV_SIMULATION not set — writes blocked at lib boundary",
      tone: enabled ? "emerald" : "amber",
    },
    {
      Icon: Trash2,
      label: "Cleanup verified",
      detail: `Reset purges all ${new Intl.NumberFormat("en-US").format(status.tenants + status.users + status.bookings + status.auditLogs)} synthetic rows by SEED marker`,
      tone: "emerald",
    },
  ];
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
      {items.map((it) => {
        const cls =
          it.tone === "emerald"
            ? "border-emerald-200 bg-emerald-50/30"
            : "border-amber-200 bg-amber-50/30";
        const iconCls = it.tone === "emerald" ? "text-emerald-600" : "text-amber-600";
        return (
          <div
            key={it.label}
            className={`rounded-xl border px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${cls}`}
          >
            <div className="flex items-center gap-2">
              <it.Icon className={`h-3.5 w-3.5 ${iconCls}`} />
              <div className="text-[12px] font-semibold text-slate-900">{it.label}</div>
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-slate-600">{it.detail}</div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Top-level client ─────────────────────────────────────────────

export default function SimulationClient({ initial }: { initial: StatusResp }) {
  const [data, setData] = React.useState<StatusResp>(initial);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [lastResult, setLastResult] = React.useState<unknown>(null);
  const [drawerInjector, setDrawerInjector] = React.useState<InjectorMeta | null>(null);
  const [heartbeatTick, setHeartbeatTick] = React.useState(0);

  React.useEffect(() => {
    const id = window.setInterval(() => setHeartbeatTick((t) => t + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  async function refresh() {
    try {
      const res = await fetch("/api/admin/dev/simulation", { cache: "no-store" });
      if (res.ok) setData((await res.json()) as StatusResp);
    } catch {}
  }

  async function post(body: object, label: string) {
    setBusy(label);
    setLastResult(null);
    try {
      const res = await fetch("/api/admin/dev/simulation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      setLastResult(json);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  const mission = deriveSimulationMission(data.status, data.enabled);
  const insights = deriveSimulationInsights(mission, data.enabled);
  const scenariosInsight = insights.find((i) => i.surface === "scenarios") ?? null;
  const injectorsInsight = insights.find((i) => i.surface === "injectors") ?? null;
  const archetypesInsight = insights.find((i) => i.surface === "archetypes") ?? null;

  const injectorsDisabled = !data.enabled || data.status.tenants === 0;

  return (
    <div className="space-y-6">
      <style jsx global>{`
        @keyframes slideInDrawer {
          from {
            transform: translateX(20px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>

      {/* Sticky topbar — chaos lab indicator + heartbeat */}
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-2xl border border-amber-200 bg-gradient-to-r from-amber-50/60 via-white to-amber-50/40 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <span className="relative inline-flex h-2 w-2">
            <span
              key={heartbeatTick}
              className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-75"
            />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          </span>
          <div>
            <div className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-amber-900">
              <FlaskConical className="h-3.5 w-3.5" />
              Chaos lab · synthetic-only environment
            </div>
            <div className="text-[11px] text-amber-700">
              Every row carries SEEDED_BY_MARKER · real customer data is never read or mutated · Reset purges by marker
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-50"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>

      {/* Enablement banner */}
      {!data.enabled ? (
        <div className="rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50/40 via-white to-white px-4 py-3 shadow-[0_0_0_1px_rgba(244,63,94,0.04)]">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-700" />
            <div className="flex-1">
              <div className="text-[13px] font-semibold tracking-tight text-rose-900">
                Lab safed — ALLOW_DEV_SIMULATION not set
              </div>
              <div className="mt-1 text-[11px] text-rose-700">
                Set <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px]">ALLOW_DEV_SIMULATION=true</code>{" "}
                in <code className="rounded bg-white px-1 py-0.5 font-mono text-[11px]">.env</code> and restart pm2 to arm
                the chaos lab. Until then, all scenario / inject / reset calls are blocked at the lib boundary.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Mission hero */}
      <SimulationMissionHero kpis={mission} insights={insights} enabled={data.enabled} />

      {/* Safety validation strip */}
      <SafetyValidationStrip enabled={data.enabled} status={data.status} />

      {/* Current footprint */}
      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <Boxes className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Synthetic footprint
          </h2>
          <span className="text-[11px] text-slate-400">all rows tagged SEEDED_BY_MARKER</span>
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <FootprintCard label="Tenants" count={data.status.tenants} Icon={Boxes} tone="sky" />
          <FootprintCard label="Users" count={data.status.users} Icon={Sparkles} tone="violet" />
          <FootprintCard label="Bookings" count={data.status.bookings} Icon={CreditCard} tone="emerald" />
          <FootprintCard label="Audit rows" count={data.status.auditLogs} Icon={Zap} tone="amber" />
        </div>
      </section>

      {/* Scenario tiers */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Play className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Scenario tiers
          </h2>
          <span className="text-[11px] text-slate-400">populate synthetic SaaS telemetry</span>
          {scenariosInsight ? (
            <div className="ml-2">
              <SimulationInsightChip insight={scenariosInsight} />
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {SCENARIO_TIERS.map((t) => (
            <ScenarioTierCard
              key={t.id}
              tier={t}
              busy={busy}
              enabled={data.enabled}
              onRun={(tierId) => post({ action: "run", mode: tierId }, `run:${tierId}`)}
            />
          ))}
        </div>
      </section>

      {/* Chaos injectors */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Zap className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Chaos injectors
          </h2>
          <span className="text-[11px] text-slate-400">controlled failure bursts on seeded tenants</span>
          {injectorsInsight ? (
            <div className="ml-2">
              <SimulationInsightChip insight={injectorsInsight} />
            </div>
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {INJECTOR_META.map((inj) => (
            <InjectorCard
              key={inj.id}
              injector={inj}
              busy={busy}
              disabled={injectorsDisabled}
              onInject={(kind) => post({ action: "inject", kind }, `inject:${kind}`)}
              onOpen={setDrawerInjector}
            />
          ))}
        </div>
        {data.enabled && data.status.tenants === 0 ? (
          <div className="mt-3 inline-flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50/30 px-3 py-2 text-[11px] text-sky-800">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-sky-600" />
            <span>Run a scenario tier first — injectors target SEEDED tenants only.</span>
          </div>
        ) : null}
      </section>

      {/* Archetype gallery */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Sparkles className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Tenant archetypes
          </h2>
          <span className="text-[11px] text-slate-400">
            {ARCHETYPES.length} vertical-specific behavioral profiles
          </span>
          {archetypesInsight ? (
            <div className="ml-2">
              <SimulationInsightChip insight={archetypesInsight} />
            </div>
          ) : null}
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="mb-3 text-[11px] text-slate-500">
            Each simulated tenant draws a vertical archetype. Booking volume, plan mix, churn risk,
            growth curve, and OAuth adoption all flow from the profile — so a CPA firm has tax-season
            spikes, a salon has weekend density, a clinic has high volume + low churn, etc.
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {ARCHETYPES.map((a) => (
              <ArchetypeCard key={a.id} a={a} />
            ))}
          </div>
        </div>
      </section>

      {/* Reset */}
      <section>
        <div className="rounded-2xl border border-rose-200 bg-gradient-to-br from-rose-50/30 via-white to-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-1.5 text-[13px] font-semibold tracking-tight text-rose-900">
                <Trash2 className="h-3.5 w-3.5" />
                Reset simulation
              </div>
              <div className="mt-1 text-[11px] leading-snug text-rose-700">
                Wipes every row tagged with the seed marker — tenants, users, bookings, audit logs.
                Real customer data is never touched even on a populated production DB.
              </div>
            </div>
            <button
              type="button"
              disabled={!data.enabled || busy !== null}
              onClick={async () => {
                const ok = await confirmAction({
                  title: "Reset synthetic simulation footprint?",
                  body: "Every row tagged with the seed marker will be wiped. Real customer data is never touched.",
                  variant: "danger",
                  confirmLabel: "Reset footprint",
                });
                if (ok) {
                  void post({ action: "reset" }, "reset");
                }
              }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-rose-300 bg-white px-3 py-1.5 text-[12px] font-semibold text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "reset" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Reset
            </button>
          </div>
        </div>
      </section>

      {/* Last result */}
      {lastResult ? (
        <section className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50/40 to-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="mb-2 flex items-center gap-1.5">
            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Last action result
            </span>
          </div>
          <pre className="overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-[11px] leading-relaxed text-slate-700">
            {JSON.stringify(lastResult, null, 2)}
          </pre>
        </section>
      ) : null}

      <InjectorDrawer
        injector={drawerInjector}
        onClose={() => setDrawerInjector(null)}
        enabled={data.enabled}
        busy={busy}
        onInject={(kind) => post({ action: "inject", kind }, `inject:${kind}`)}
      />
    </div>
  );
}
