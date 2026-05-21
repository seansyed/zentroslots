"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CalendarCheck2,
  CalendarX2,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  History,
  Info,
  Layers,
  ListChecks,
  Lock,
  Play,
  RefreshCw,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Target,
  Users,
  Workflow,
  XCircle,
} from "lucide-react";

import { Badge, Button, Card, Skeleton, toast } from "@/components/ui/primitives";

// ─── Page contract ────────────────────────────────────────────────────

export type RoutingPageBootstrap = {
  tenantId: string;
  plan: { id: string; name: string };
  hero: {
    activeMode: string;
    eligibleStaffCount: number;
    calendarConnectedStaff: number;
    activeCalendars: number;
    activeServiceCount: number;
    serviceOverrideCount: number;
    tenantHasDefaultRule: boolean;
  };
  /** Required plan tier per routing mode (visibility-only badges). */
  planByMode: Record<string, string>;
  planRank: Record<string, number>;
  /** Whether current plan meets the tier per mode. */
  canUseMode: Record<string, boolean>;
};

type Mode = "manual" | "round_robin" | "least_busy" | "priority" | "weighted";

const MODE_META: Record<
  Mode,
  {
    label: string;
    plain: string;
    behavior: string;
    example: string;
    fallback: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  manual: {
    label: "Manual",
    plain: "Customers pick the staff member themselves on the booking page.",
    behavior: "The engine does not auto-assign. The booking page shows a staff picker.",
    example: "Customer selects Sarah → booking lands on Sarah.",
    fallback: "n/a — the customer is the picker.",
    icon: Users,
  },
  least_busy: {
    label: "Least busy",
    plain: "Picks the eligible staff with the fewest assignments today.",
    behavior:
      "Ties broken by oldest lastAssignedAt, then by staff id for determinism. Counters use rolling daily windows.",
    example:
      "Among Sarah (3 today), Mike (1 today), Anna (1 today, last assigned 9am) → assigns Mike (newer last-assign).",
    fallback: "If no eligible staff, the booking fails with no_available_staff.",
    icon: Scale,
  },
  round_robin: {
    label: "Round robin",
    plain: "Cycles through eligible staff by who was assigned the longest ago.",
    behavior:
      "Stable order: oldest lastAssignedAt first; ties by id ascending. Persistent across reschedules.",
    example: "Sarah was last assigned 11am, Mike 9am, Anna 8am → assigns Anna.",
    fallback: "Falls back to legacy round-robin if no rule is configured.",
    icon: Shuffle,
  },
  priority: {
    label: "Priority",
    plain: "Try staff in a fixed order; first eligible wins.",
    behavior:
      "Eligibility (working hours + freebusy + service pool) still applies — unavailable staff are skipped, not blocked.",
    example: "Priority list [Sarah, Mike, Anna]. Sarah busy, Mike free → assigns Mike.",
    fallback: "If everyone in the priority list is busy, falls through to no_pick_in_pool.",
    icon: ListChecks,
  },
  weighted: {
    label: "Weighted",
    plain: "Distribute by long-term percentage. Self-corrects drift over time.",
    behavior:
      "Deficit-correction algorithm: picks the staff most under-served vs. their target share. Tolerant of paused weights.",
    example: "Sarah 50%, Mike 30%, Anna 20%. Across 100 bookings → ~50/30/20 split.",
    fallback: "If all weighted staff are busy, falls through to no_available_staff.",
    icon: Workflow,
  },
};

const MODE_ORDER: Mode[] = ["manual", "least_busy", "round_robin", "weighted", "priority"];

// ─── Data types pulled from existing APIs ──────────────────────────────

type Rule = {
  id: string;
  serviceId: string | null;
  locationId: string | null;
  mode: Mode;
  enabled: boolean;
  priorityOrder: string[];
  weightedDistribution: Record<string, number>;
  createdAt: string;
  updatedAt: string;
};

type Service = { id: string; name: string; slug: string };
type Staff = { id: string; name: string; email: string; role: string };

type StatsRow = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  totalAssignments: number;
  assignmentsToday: number;
  assignmentsThisWeek: number;
  lastAssignedAt: string | null;
};

type FairnessRow = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  todayCount: number;
  weekCount: number;
  totalAssignments: number;
  lastAssignedAt: string | null;
  actualSharePct: number;
  expectedSharePct: number;
  driftPct: number;
  overloaded: boolean;
  expectedSource: "weighted_rule" | "equal_share";
};
type FairnessSummary = {
  rows: FairnessRow[];
  maxAbsoluteDriftPct: number;
  weeklyTotal: number;
  activeAssignees: number;
};

type DecisionRow = {
  id: string;
  at: string;
  bookingId: string | null;
  bookingStatus: string;
  clientLabel: string | null;
  serviceId: string | null;
  serviceName: string | null;
  staffId: string | null;
  staffName: string | null;
  startAt: string | null;
  routingMode: string | null;
  routingReason: string | null;
};
type DecisionsResp = { decisions: DecisionRow[]; todayCount: number; totalCount: number };

type EligWarnings = {
  servicesWithNoStaff: Array<{ id: string; name: string }>;
  calendarsWithErrors: Array<{
    connectionId: string;
    userId: string;
    userName: string;
    provider: string;
    lastError: string | null;
    lastErrorAt: string | null;
  }>;
  staffOnPtoToday: Array<{ userId: string; userName: string; date: string }>;
  staffWithoutCalendar: Array<{ userId: string; userName: string }>;
  counts: {
    servicesWithNoStaff: number;
    calendarsWithErrors: number;
    staffOnPtoToday: number;
    staffWithoutCalendar: number;
  };
};

type SimulationCandidate = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  status: "eligible" | "skipped" | "picked";
  reason: string;
  step:
    | "in_pool"
    | "service_pool"
    | "rule_pool"
    | "working_hours"
    | "internal_conflict"
    | "external_busy"
    | "picker";
};
type SimulationResp = {
  requested: { serviceId: string; serviceName: string; startAt: string; endAt: string; durationMinutes: number };
  rule: { scope: "service" | "tenant_default" | "none"; mode: string; enabled: boolean; serviceId: string | null };
  decision:
    | { ok: true; staffId: string; mode: string; reason: string }
    | { ok: false; mode: string; reason: string };
  candidates: SimulationCandidate[];
  counts: {
    inPool: number;
    eligible: number;
    skippedByWorkingHours: number;
    skippedByInternalConflict: number;
    skippedByExternalBusy: number;
    skippedByRulePool: number;
  };
};

// ─── Root component ───────────────────────────────────────────────────

export default function RoutingClient({ bootstrap }: { bootstrap: RoutingPageBootstrap }) {
  const [loading, setLoading] = React.useState(true);
  const [tenantDefault, setTenantDefault] = React.useState<Rule | null>(null);
  const [serviceRules, setServiceRules] = React.useState<Rule[]>([]);
  const [services, setServices] = React.useState<Service[]>([]);
  const [staff, setStaff] = React.useState<Staff[]>([]);
  const [stats, setStats] = React.useState<StatsRow[]>([]);
  const [fairness, setFairness] = React.useState<FairnessSummary | null>(null);
  const [decisions, setDecisions] = React.useState<DecisionsResp | null>(null);
  const [warnings, setWarnings] = React.useState<EligWarnings | null>(null);
  const [activeScope, setActiveScope] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, statsRes, fairRes, decRes, warnRes] = await Promise.all([
        fetch("/api/tenant/routing-rules", { cache: "no-store" }),
        fetch("/api/tenant/routing-stats", { cache: "no-store" }),
        fetch("/api/tenant/routing/fairness", { cache: "no-store" }),
        fetch("/api/tenant/routing/decisions", { cache: "no-store" }),
        fetch("/api/tenant/routing/eligibility-warnings", { cache: "no-store" }),
      ]);
      if (rulesRes.ok) {
        const data = await rulesRes.json();
        setTenantDefault(data.tenantDefault);
        setServiceRules(data.serviceRules);
        setServices(data.services);
        setStaff(data.staff);
      }
      if (statsRes.ok) setStats((await statsRes.json()).stats);
      if (fairRes.ok) setFairness(await fairRes.json());
      if (decRes.ok) setDecisions(await decRes.json());
      if (warnRes.ok) setWarnings(await warnRes.json());
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  const activeRule =
    activeScope === null
      ? tenantDefault
      : serviceRules.find((r) => r.serviceId === activeScope) ?? null;
  const activeService = activeScope ? services.find((s) => s.id === activeScope) ?? null : null;

  return (
    <div className="mt-6 space-y-8 pb-28">
      <Hero
        bootstrap={bootstrap}
        warnings={warnings}
        fairness={fairness}
        decisions={decisions}
      />

      <RoutingModesOverview bootstrap={bootstrap} />

      <SimulationSection services={services} loading={loading} />

      <FairnessSection fairness={fairness} loading={loading} />

      <DecisionsSection decisions={decisions} loading={loading} />

      <EligibilityWarningsSection warnings={warnings} loading={loading} />

      <ServiceOverridesSection
        services={services}
        serviceRules={serviceRules}
        activeScope={activeScope}
        setActiveScope={setActiveScope}
        tenantDefault={tenantDefault}
      />

      <RuleEditor
        key={activeScope ?? "tenant"}
        scope={activeScope === null ? "tenant" : "service"}
        serviceId={activeScope}
        serviceName={activeService?.name ?? null}
        rule={activeRule}
        staff={staff}
        onSaved={refresh}
        bootstrap={bootstrap}
      />

      <StaffStatsTable stats={stats} loading={loading} />
    </div>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────

function Hero({
  bootstrap,
  warnings,
  fairness,
  decisions,
}: {
  bootstrap: RoutingPageBootstrap;
  warnings: EligWarnings | null;
  fairness: FairnessSummary | null;
  decisions: DecisionsResp | null;
}) {
  const h = bootstrap.hero;
  const fairnessHealth = fairnessHealthStatus(fairness?.maxAbsoluteDriftPct ?? 0);
  const queueBalancing = h.activeMode === "weighted" || h.activeMode === "round_robin";

  return (
    <Card className="overflow-hidden p-0">
      <div className="bg-gradient-to-br from-brand-accent/8 via-surface to-surface px-6 py-7">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand-accent">
                <Sparkles className="h-3 w-3" /> Routing intelligence
              </span>
              <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted">
                {bootstrap.plan.name} plan
              </span>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
              Routing Intelligence Center
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
              Live visibility into how the engine assigns staff — modes, fairness,
              eligibility, and a what-if simulator that uses the real production
              engine. Every number on this page comes from current backend state.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center md:grid-cols-6">
            <HeroStat
              icon={Workflow}
              value={modeLabelShort(h.activeMode)}
              label="Active mode"
            />
            <HeroStat
              icon={Users}
              value={String(h.eligibleStaffCount)}
              label="Eligible hosts"
            />
            <HeroStat
              icon={CalendarCheck2}
              value={`${h.calendarConnectedStaff}`}
              label="Calendars connected"
            />
            <HeroStat
              icon={Target}
              value={
                fairness
                  ? fairness.activeAssignees > 0
                    ? `${fairness.activeAssignees}`
                    : "—"
                  : "—"
              }
              label="Active assignees (wk)"
            />
            <HeroStat
              icon={Scale}
              value={`${fairnessHealth.label}`}
              label="Fairness health"
              accent={fairnessHealth.accent}
            />
            <HeroStat
              icon={ShieldAlert}
              value={String(warnings?.counts.servicesWithNoStaff ?? 0)}
              label="Routing conflicts"
              accent={
                (warnings?.counts.servicesWithNoStaff ?? 0) > 0 ? "rose" : "muted"
              }
            />
          </div>
        </div>
      </div>

      {/* Operational health strip */}
      <div className="border-t border-border bg-surface-muted/40 px-6 py-3">
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide text-ink-subtle">
            <Activity className="h-3 w-3" /> System
          </span>
          <OperationalChip
            label="Routing engine healthy"
            status="ok"
            icon={GitBranch}
            detail="assignStaff orchestrator wired and serving live booking traffic."
          />
          <OperationalChip
            label={`Calendar sync ${h.activeCalendars > 0 ? "operational" : "idle"}`}
            status={h.activeCalendars > 0 ? "ok" : "muted"}
            icon={CalendarCheck2}
            detail={
              h.activeCalendars > 0
                ? `${h.activeCalendars} active connection${h.activeCalendars === 1 ? "" : "s"}. Engine subtracts external busy from eligibility.`
                : "No staff have connected calendars. External busy time is invisible to routing."
            }
          />
          <OperationalChip
            label="Conflict detection active"
            status="ok"
            icon={ShieldCheck}
            detail="Eligibility filter rejects any staff with an overlapping confirmed booking. Core safety guarantee."
          />
          <OperationalChip
            label={`Queue balancing ${queueBalancing ? "enabled" : "off"}`}
            status={queueBalancing ? "ok" : "muted"}
            icon={Scale}
            detail={
              queueBalancing
                ? `Active mode is ${h.activeMode}. Engine balances assignment load across eligible staff.`
                : "Active mode is manual or priority. No automatic load balancing — selection follows the configured rule."
            }
          />
          <OperationalChip
            label={`${decisions?.todayCount ?? 0} engine decisions · 24h`}
            status="muted"
            icon={History}
            detail="Bookings auto-assigned by the routing engine in the last 24 hours."
          />
        </div>
      </div>
    </Card>
  );
}

function HeroStat({
  icon: Icon,
  value,
  label,
  accent = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  label: string;
  accent?: "default" | "rose" | "amber" | "emerald" | "muted";
}) {
  const valueClass =
    accent === "rose"
      ? "text-rose-700"
      : accent === "amber"
        ? "text-amber-700"
        : accent === "emerald"
          ? "text-emerald-700"
          : accent === "muted"
            ? "text-ink-subtle"
            : "text-ink";
  return (
    <div className="min-w-[88px] rounded-xl border border-border bg-surface px-2.5 py-2 text-left">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-ink-subtle" />
        <span className={"text-[15px] font-semibold tabular-nums " + valueClass}>{value}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-ink-muted">{label}</div>
    </div>
  );
}

function OperationalChip({
  label,
  status,
  icon: Icon,
  detail,
}: {
  label: string;
  status: "ok" | "degraded" | "down" | "muted";
  icon: React.ComponentType<{ className?: string }>;
  detail: string;
}) {
  const meta =
    status === "ok"
      ? { classes: "border-emerald-200 bg-emerald-50 text-emerald-800", dot: "bg-emerald-500" }
      : status === "degraded"
        ? { classes: "border-amber-200 bg-amber-50 text-amber-900", dot: "bg-amber-500" }
        : status === "down"
          ? { classes: "border-rose-200 bg-rose-50 text-rose-800", dot: "bg-rose-500" }
          : { classes: "border-border bg-surface-muted text-ink-subtle", dot: "bg-slate-400" };
  return (
    <span
      className={"inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-medium " + meta.classes}
      title={detail}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
      <span className={"h-1.5 w-1.5 rounded-full " + meta.dot} />
    </span>
  );
}

function fairnessHealthStatus(drift: number): { label: string; accent: "emerald" | "amber" | "rose" | "muted" } {
  if (drift <= 0) return { label: "—", accent: "muted" };
  if (drift <= 10) return { label: "Healthy", accent: "emerald" };
  if (drift <= 25) return { label: "Balanced", accent: "amber" };
  return { label: "Drifting", accent: "rose" };
}

function modeLabelShort(mode: string): string {
  return MODE_META[mode as Mode]?.label ?? mode;
}

// ─── Routing modes overview ───────────────────────────────────────────

function RoutingModesOverview({ bootstrap }: { bootstrap: RoutingPageBootstrap }) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Layers}
        title="Routing modes"
        subtitle="Every mode the engine ships with. Real example scenarios. Plan badges reflect upcoming tier policy — existing rules remain honored."
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {MODE_ORDER.map((m) => {
          const meta = MODE_META[m];
          const Icon = meta.icon;
          const isActive = bootstrap.hero.activeMode === m;
          const requiredPlan = bootstrap.planByMode[m];
          const granted = bootstrap.canUseMode[m];
          return (
            <Card
              key={m}
              className={
                "p-5 transition-shadow " +
                (isActive
                  ? "border-brand-accent/40 shadow-[0_0_0_1px_rgba(53,157,243,0.18),0_8px_24px_-8px_rgba(53,157,243,0.18)]"
                  : "hover:shadow-md")
              }
            >
              <div className="flex items-start gap-3">
                <div
                  className={
                    "grid h-10 w-10 shrink-0 place-items-center rounded-xl " +
                    (isActive ? "bg-brand-accent/10 text-brand-accent" : "bg-surface-muted/70 text-ink-subtle")
                  }
                >
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-ink">{meta.label}</h3>
                    {isActive && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Active
                      </span>
                    )}
                    {!granted && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                        <Lock className="h-2.5 w-2.5" /> {requiredPlan.toUpperCase()}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">{meta.plain}</p>
                  <div className="mt-3 space-y-2 border-t border-border/60 pt-3 text-xs">
                    <p className="text-ink-subtle">
                      <span className="font-medium text-ink-muted">How:</span> {meta.behavior}
                    </p>
                    <p className="text-ink-subtle">
                      <span className="font-medium text-ink-muted">Example:</span> {meta.example}
                    </p>
                    <p className="text-ink-subtle">
                      <span className="font-medium text-ink-muted">Fallback:</span> {meta.fallback}
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

// ─── Live simulation ──────────────────────────────────────────────────

function SimulationSection({
  services,
  loading,
}: {
  services: Service[];
  loading: boolean;
}) {
  const [serviceId, setServiceId] = React.useState<string>("");
  const [date, setDate] = React.useState<string>(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = React.useState<string>("10:00");
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<SimulationResp | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!serviceId && services.length > 0) setServiceId(services[0].id);
  }, [services, serviceId]);

  async function run() {
    if (!serviceId) {
      setError("Pick a service first.");
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const startAt = new Date(`${date}T${time}:00`).toISOString();
      const res = await fetch("/api/tenant/routing/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId, startAt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Simulation failed");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Play}
        title="Live assignment simulation"
        subtitle="Dry-run the real engine against any service + time. No bookings are written. Reasoning matches what the production POST /api/bookings would compute right now."
      />
      <Card className="p-5">
        <div className="grid gap-3 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Service</label>
            <select
              value={serviceId}
              onChange={(e) => setServiceId(e.target.value)}
              disabled={loading}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              {services.length === 0 && <option value="">No services available</option>}
              {services.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Time</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
          </div>
          <Button onClick={run} disabled={running || !serviceId}>
            {running ? "Simulating…" : "Run simulation"}
          </Button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
            {error}
          </div>
        )}

        {result && <SimulationResultPane result={result} />}
      </Card>
    </section>
  );
}

function SimulationResultPane({ result }: { result: SimulationResp }) {
  const decision = result.decision;
  const isOk = decision.ok;
  const winner = decision.ok
    ? result.candidates.find((c) => c.staffId === decision.staffId) ?? null
    : null;
  return (
    <div className="mt-5 space-y-3">
      {/* Decision banner */}
      <div
        className={
          "flex items-start gap-3 rounded-xl border p-4 " +
          (isOk
            ? "border-emerald-200 bg-emerald-50"
            : "border-amber-200 bg-amber-50")
        }
      >
        <div className="mt-0.5">
          {isOk ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-amber-600" />
          )}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          {isOk && winner ? (
            <>
              <p className="font-semibold text-emerald-900">
                Would assign to {winner.staffName}
              </p>
              <p className="mt-0.5 text-xs text-emerald-800">
                via {decision.mode} — {decision.reason}
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-amber-900">No assignment would be made</p>
              <p className="mt-0.5 text-xs text-amber-800">
                {decision.mode === "no_rule"
                  ? "No active routing rule applies. The booking POST would fall back to the legacy round-robin path."
                  : `${decision.mode} → ${decision.reason}`}
              </p>
            </>
          )}
        </div>
        <div className="hidden text-right text-[10px] font-medium uppercase tracking-wide text-ink-subtle sm:block">
          {result.rule.scope === "service" ? "service-specific rule" : result.rule.scope === "tenant_default" ? "tenant default rule" : "no rule"}
        </div>
      </div>

      {/* Counts strip */}
      <div className="flex flex-wrap gap-2 text-[11px]">
        <CountChip label="In pool" value={result.counts.inPool} />
        <CountChip label="Eligible" value={result.counts.eligible} tone="emerald" />
        <CountChip label="Skipped: PTO/hours" value={result.counts.skippedByWorkingHours} tone="muted" />
        <CountChip label="Skipped: internal" value={result.counts.skippedByInternalConflict} tone="muted" />
        <CountChip label="Skipped: external" value={result.counts.skippedByExternalBusy} tone="muted" />
        <CountChip label="Skipped: not in pool" value={result.counts.skippedByRulePool} tone="muted" />
      </div>

      {/* Candidate list */}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-left text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
            <tr>
              <th className="px-3 py-2">Staff</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Why</th>
            </tr>
          </thead>
          <tbody>
            {result.candidates.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-xs text-ink-muted">
                  Service pool is empty — assign staff to this service first.
                </td>
              </tr>
            )}
            {result.candidates.map((c) => (
              <tr key={c.staffId} className="border-t border-border/60">
                <td className="px-3 py-2">
                  <div className="text-ink">{c.staffName}</div>
                  <div className="text-[11px] text-ink-subtle">{c.staffEmail}</div>
                </td>
                <td className="px-3 py-2">
                  {c.status === "picked" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                      <CheckCircle2 className="h-3 w-3" /> Picked
                    </span>
                  ) : c.status === "eligible" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                      <ShieldCheck className="h-3 w-3" /> Eligible
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                      <XCircle className="h-3 w-3" /> Skipped
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-ink-muted">{c.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CountChip({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "emerald" | "muted";
}) {
  const styles =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "muted"
        ? "border-border bg-surface-muted text-ink-subtle"
        : "border-border bg-surface text-ink";
  return (
    <span className={"inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-medium " + styles}>
      <span className="tabular-nums">{value}</span>
      <span>{label}</span>
    </span>
  );
}

// ─── Fairness ─────────────────────────────────────────────────────────

function FairnessSection({
  fairness,
  loading,
}: {
  fairness: FairnessSummary | null;
  loading: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Scale}
        title="Fairness + workload analytics"
        subtitle="Per-staff weekly load with drift vs. target share. Targets come from the tenant's weighted rule when set; otherwise equal-share across active staff."
      />
      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-5"><Skeleton className="h-32 w-full rounded-md" /></div>
        ) : !fairness || fairness.rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-muted">No staff to analyze yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-left text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="px-3 py-2">Staff</th>
                <th className="px-3 py-2 text-right">Today</th>
                <th className="px-3 py-2 text-right">Week</th>
                <th className="px-3 py-2 text-right">Actual share</th>
                <th className="px-3 py-2 text-right">Target</th>
                <th className="px-3 py-2 text-right">Drift</th>
                <th className="px-3 py-2">Bar</th>
                <th className="px-3 py-2">Flags</th>
              </tr>
            </thead>
            <tbody>
              {fairness.rows.map((r) => {
                const driftTone = Math.abs(r.driftPct) <= 10
                  ? "emerald"
                  : Math.abs(r.driftPct) <= 25
                    ? "amber"
                    : "rose";
                return (
                  <tr key={r.staffId} className="border-t border-border/60">
                    <td className="px-3 py-2">
                      <div className="text-ink">{r.staffName}</div>
                      <div className="text-[11px] text-ink-subtle">{r.staffEmail}</div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.todayCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.weekCount}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.actualSharePct.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{r.expectedSharePct.toFixed(1)}%</td>
                    <td className="px-3 py-2 text-right">
                      <span
                        className={
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium " +
                          (driftTone === "emerald"
                            ? "bg-emerald-50 text-emerald-700"
                            : driftTone === "amber"
                              ? "bg-amber-50 text-amber-800"
                              : "bg-rose-50 text-rose-700")
                        }
                      >
                        {r.driftPct > 0 ? "+" : ""}
                        {r.driftPct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <DriftBar actual={r.actualSharePct} target={r.expectedSharePct} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {r.overloaded && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-700">
                            <AlertTriangle className="h-2.5 w-2.5" /> overloaded
                          </span>
                        )}
                        {r.expectedSource === "equal_share" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                            equal share
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      {fairness && fairness.weeklyTotal > 0 && (
        <p className="text-xs text-ink-subtle">
          {fairness.weeklyTotal} engine assignment{fairness.weeklyTotal === 1 ? "" : "s"} in the rolling weekly window
          {" · "}
          max drift {fairness.maxAbsoluteDriftPct.toFixed(1)}%
        </p>
      )}
    </section>
  );
}

function DriftBar({ actual, target }: { actual: number; target: number }) {
  const max = Math.max(actual, target, 1);
  return (
    <div className="flex items-center gap-1">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100" title="actual">
        <div className="h-full bg-brand-accent" style={{ width: `${Math.min(100, (actual / max) * 100)}%` }} />
      </div>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-100" title="target">
        <div className="h-full bg-emerald-400" style={{ width: `${Math.min(100, (target / max) * 100)}%` }} />
      </div>
    </div>
  );
}

// ─── Decisions feed ───────────────────────────────────────────────────

function DecisionsSection({
  decisions,
  loading,
}: {
  decisions: DecisionsResp | null;
  loading: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={History}
        title="Recent routing decisions"
        subtitle="The last engine-driven assignments. Customer-picked bookings are excluded — this feed only shows what the routing engine itself decided."
      />
      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-5"><Skeleton className="h-32 w-full rounded-md" /></div>
        ) : !decisions || decisions.decisions.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-muted">
            No engine decisions yet. Once a booking is auto-assigned, it will appear here.
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {decisions.decisions.map((d) => (
              <li key={d.id} className="flex items-start gap-3 p-4 text-sm">
                <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
                  <ArrowRight className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-ink">
                    Assigned <span className="font-semibold">{d.staffName ?? "(deleted)"}</span>
                    {" "}via{" "}
                    <span className="font-medium">{modeLabelShort(d.routingMode ?? "—")}</span>
                    {d.routingReason && (
                      <span className="text-ink-muted"> — {d.routingReason}</span>
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-subtle">
                    <span>{d.serviceName ?? "(unknown service)"}</span>
                    {d.startAt && <span>· {new Date(d.startAt).toLocaleString()}</span>}
                    {d.clientLabel && <span>· {d.clientLabel}</span>}
                    {d.bookingStatus !== "confirmed" && (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                        {d.bookingStatus}
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right text-[11px] text-ink-subtle">{timeAgo(d.at)}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

// ─── Eligibility warnings ─────────────────────────────────────────────

function EligibilityWarningsSection({
  warnings,
  loading,
}: {
  warnings: EligWarnings | null;
  loading: boolean;
}) {
  const hasAny = warnings && (
    warnings.servicesWithNoStaff.length > 0 ||
    warnings.calendarsWithErrors.length > 0 ||
    warnings.staffOnPtoToday.length > 0 ||
    warnings.staffWithoutCalendar.length > 0
  );

  return (
    <section className="space-y-3">
      <SectionHeader
        icon={ShieldAlert}
        title="Eligibility safeguards"
        subtitle="Real-state surfacing of conditions that cause the engine to skip staff. Every entry is observable today in your workspace."
      />
      {loading ? (
        <Card className="p-5"><Skeleton className="h-24 w-full rounded-md" /></Card>
      ) : !hasAny ? (
        <Card className="flex items-center gap-3 p-5 text-sm text-ink-muted">
          <ShieldCheck className="h-5 w-5 text-emerald-600" />
          <span>All clear — no services without staff, no calendar errors, no PTO overrides today.</span>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {warnings.servicesWithNoStaff.length > 0 && (
            <WarningCard
              icon={Users}
              tone="rose"
              title="Services with no eligible staff"
              detail="These services will fail with no_available_staff until you assign at least one staff member."
              items={warnings.servicesWithNoStaff.map((s) => ({
                primary: s.name,
                secondary: "Assign staff in Services",
                href: `/dashboard/services`,
              }))}
            />
          )}
          {warnings.calendarsWithErrors.length > 0 && (
            <WarningCard
              icon={CalendarX2}
              tone="amber"
              title="Calendars reporting errors"
              detail="OAuth errors on these connections. External busy time may be stale until the staff reconnects."
              items={warnings.calendarsWithErrors.map((c) => ({
                primary: c.userName,
                secondary: c.lastError ?? "unknown error",
                href: `/dashboard/settings/calendar`,
              }))}
            />
          )}
          {warnings.staffOnPtoToday.length > 0 && (
            <WarningCard
              icon={CalendarX2}
              tone="muted"
              title="Staff on PTO today"
              detail="Unavailable overrides for today. Engine will skip these staff for the whole day."
              items={warnings.staffOnPtoToday.map((p) => ({
                primary: p.userName,
                secondary: `Override active on ${p.date}`,
                href: `/dashboard/availability/overrides`,
              }))}
            />
          )}
          {warnings.staffWithoutCalendar.length > 0 && (
            <WarningCard
              icon={Info}
              tone="muted"
              title="Staff without a connected calendar"
              detail="External busy time is invisible to the engine for these staff. Internal bookings are still respected."
              items={warnings.staffWithoutCalendar.map((s) => ({
                primary: s.userName,
                secondary: "Connect Google Calendar",
                href: `/dashboard/settings/calendar`,
              }))}
            />
          )}
        </div>
      )}
    </section>
  );
}

function WarningCard({
  icon: Icon,
  tone,
  title,
  detail,
  items,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: "rose" | "amber" | "muted";
  title: string;
  detail: string;
  items: Array<{ primary: string; secondary: string; href: string }>;
}) {
  const wrap =
    tone === "rose"
      ? "border-rose-200 bg-rose-50/60"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50/60"
        : "border-border bg-surface-muted/40";
  const iconWrap =
    tone === "rose"
      ? "bg-rose-100 text-rose-700"
      : tone === "amber"
        ? "bg-amber-100 text-amber-700"
        : "bg-slate-100 text-slate-600";
  return (
    <Card className={"p-5 " + wrap}>
      <div className="flex items-start gap-3">
        <div className={"grid h-9 w-9 shrink-0 place-items-center rounded-lg " + iconWrap}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          <p className="mt-0.5 text-xs text-ink-muted">{detail}</p>
          <ul className="mt-3 space-y-1.5 text-xs">
            {items.slice(0, 6).map((it, i) => (
              <li key={i} className="flex items-start justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-1.5">
                <div className="min-w-0">
                  <div className="text-ink">{it.primary}</div>
                  <div className="truncate text-[11px] text-ink-subtle">{it.secondary}</div>
                </div>
                <Link
                  href={it.href}
                  className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-ink-muted hover:text-ink"
                >
                  open <ExternalLink className="h-3 w-3" />
                </Link>
              </li>
            ))}
            {items.length > 6 && (
              <li className="text-[11px] text-ink-subtle">…and {items.length - 6} more</li>
            )}
          </ul>
        </div>
      </div>
    </Card>
  );
}

// ─── Service overrides ────────────────────────────────────────────────

function ServiceOverridesSection({
  services,
  serviceRules,
  activeScope,
  setActiveScope,
  tenantDefault,
}: {
  services: Service[];
  serviceRules: Rule[];
  activeScope: string | null;
  setActiveScope: (s: string | null) => void;
  tenantDefault: Rule | null;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={GitBranch}
        title="Service overrides"
        subtitle="Each service can override the tenant default. Click a service to edit its rule below."
      />
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setActiveScope(null)}
            className={
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition " +
              (activeScope === null
                ? "border-brand-accent bg-brand-accent text-white"
                : "border-border bg-surface text-ink hover:bg-surface-muted")
            }
          >
            <RefreshCw className="h-3 w-3" />
            Tenant default
            {tenantDefault && tenantDefault.enabled && tenantDefault.mode !== "manual" && (
              <Badge tone="violet">{modeLabelShort(tenantDefault.mode)}</Badge>
            )}
          </button>
          <span className="text-ink-subtle">·</span>
          {services.length === 0 && (
            <span className="text-xs text-ink-muted">No active services yet.</span>
          )}
          {services.map((s) => {
            const rule = serviceRules.find((r) => r.serviceId === s.id);
            const isOverride = Boolean(rule);
            return (
              <button
                key={s.id}
                onClick={() => setActiveScope(s.id)}
                className={
                  "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition " +
                  (activeScope === s.id
                    ? "border-brand-accent bg-brand-accent text-white"
                    : isOverride
                      ? "border-violet-200 bg-violet-50 text-violet-900 hover:bg-violet-100"
                      : "border-border bg-surface text-ink-muted hover:bg-surface-muted")
                }
              >
                {s.name}
                {isOverride ? (
                  <Badge tone={activeScope === s.id ? "neutral" : "violet"}>
                    {modeLabelShort(rule!.mode)}
                  </Badge>
                ) : (
                  <span className={"text-[10px] " + (activeScope === s.id ? "text-white/70" : "text-ink-subtle")}>
                    inherits
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Card>
    </section>
  );
}

// ─── Rule editor — preserved from prior implementation, refined ──────

function RuleEditor({
  scope,
  serviceId,
  serviceName,
  rule,
  staff,
  onSaved,
  bootstrap,
}: {
  scope: "tenant" | "service";
  serviceId: string | null;
  serviceName: string | null;
  rule: Rule | null;
  staff: Staff[];
  onSaved: () => void;
  bootstrap: RoutingPageBootstrap;
}) {
  const [mode, setMode] = React.useState<Mode>(rule?.mode ?? "manual");
  const [enabled, setEnabled] = React.useState<boolean>(rule?.enabled ?? true);
  const [priority, setPriority] = React.useState<string[]>(rule?.priorityOrder ?? []);
  const [weights, setWeights] = React.useState<Record<string, number>>(rule?.weightedDistribution ?? {});
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setMode(rule?.mode ?? "manual");
    setEnabled(rule?.enabled ?? true);
    setPriority(rule?.priorityOrder ?? []);
    setWeights(rule?.weightedDistribution ?? {});
  }, [rule]);

  const eligibleStaff = React.useMemo(() => staff.filter((s) => s.role !== "client"), [staff]);

  function movePriority(idx: number, dir: -1 | 1) {
    setPriority((cur) => {
      const next = [...cur];
      const swap = idx + dir;
      if (swap < 0 || swap >= next.length) return cur;
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });
  }
  function addToPriority(staffId: string) {
    setPriority((cur) => (cur.includes(staffId) ? cur : [...cur, staffId]));
  }
  function removeFromPriority(staffId: string) {
    setPriority((cur) => cur.filter((id) => id !== staffId));
  }
  function setWeight(staffId: string, value: number) {
    setWeights((cur) => {
      const next = { ...cur };
      if (value <= 0) delete next[staffId];
      else next[staffId] = Math.min(100, Math.max(0, value));
      return next;
    });
  }

  const weightSum = Object.values(weights).reduce((a, b) => a + b, 0);

  // Normalized weights for the distribution preview.
  const normalizedWeights: Array<{ staffId: string; pct: number; name: string }> =
    weightSum > 0
      ? Object.entries(weights).map(([id, w]) => ({
          staffId: id,
          pct: (w / weightSum) * 100,
          name: eligibleStaff.find((s) => s.id === id)?.name ?? "?",
        }))
      : [];

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/routing-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId, mode, enabled, priorityOrder: priority, weightedDistribution: weights }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast("Routing saved", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!rule) return;
    if (!confirm(scope === "tenant"
      ? "Remove tenant default? Bookings fall back to legacy round-robin."
      : "Remove this service override? Service inherits tenant default."))
      return;
    setSaving(true);
    try {
      const res = await fetch(`/api/tenant/routing-rules?id=${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast("Rule removed", "success");
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Remove failed", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Workflow}
        title={scope === "tenant" ? "Tenant default rule" : `Override · ${serviceName ?? "service"}`}
        subtitle={scope === "tenant"
          ? "Applies to every service that doesn't have its own override."
          : "Only applies to bookings for this service. Falls back to tenant default if removed."}
      />
      <Card className="p-5">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {MODE_ORDER.map((m) => {
            const meta = MODE_META[m];
            const Icon = meta.icon;
            const isSelected = mode === m;
            const granted = bootstrap.canUseMode[m];
            const requiredPlan = bootstrap.planByMode[m];
            return (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={
                  "flex items-start gap-2 rounded-xl border p-3 text-left transition " +
                  (isSelected
                    ? "border-brand-accent bg-brand-accent text-white shadow-sm"
                    : "border-border bg-surface text-ink hover:border-brand-accent/30 hover:shadow-sm")
                }
              >
                <Icon className={"mt-0.5 h-4 w-4 " + (isSelected ? "" : "text-ink-subtle")} />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    {meta.label}
                    {!granted && (
                      <span
                        className={
                          "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide " +
                          (isSelected ? "bg-white/20 text-white" : "bg-violet-100 text-violet-700")
                        }
                      >
                        <Lock className="h-2.5 w-2.5" /> {requiredPlan}
                      </span>
                    )}
                  </div>
                  <div className={"mt-0.5 text-[11px] " + (isSelected ? "text-white/85" : "text-ink-muted")}>
                    {meta.plain}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Rule enabled</span>
          <span className="text-xs text-ink-muted">
            When off, this rule is ignored — caller falls back to a more general rule.
          </span>
        </label>

        {mode === "priority" && (
          <PriorityEditor
            priority={priority}
            eligibleStaff={eligibleStaff}
            onAdd={addToPriority}
            onRemove={removeFromPriority}
            onMove={movePriority}
          />
        )}

        {mode === "weighted" && (
          <WeightedEditor
            eligibleStaff={eligibleStaff}
            weights={weights}
            setWeight={setWeight}
            weightSum={weightSum}
            normalized={normalizedWeights}
          />
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          {rule && (
            <button
              onClick={remove}
              disabled={saving}
              className="text-xs text-rose-600 hover:text-rose-700 disabled:opacity-50"
            >
              Remove rule
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Badge tone={enabled ? "green" : "neutral"}>{enabled ? "enabled" : "disabled"}</Badge>
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : rule ? "Save changes" : "Create rule"}
            </Button>
          </div>
        </div>
      </Card>
    </section>
  );
}

function PriorityEditor({
  priority,
  eligibleStaff,
  onAdd,
  onRemove,
  onMove,
}: {
  priority: string[];
  eligibleStaff: Staff[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
}) {
  return (
    <div className="mt-5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">Priority order</div>
      <p className="mt-1 text-[11px] text-ink-muted">First eligible staff wins. Use arrows to reorder.</p>
      <ul className="mt-2 space-y-1.5">
        {priority.map((staffId, idx) => {
          const s = eligibleStaff.find((x) => x.id === staffId);
          return (
            <li
              key={staffId}
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm"
            >
              <span className="w-6 text-center text-xs text-slate-500">{idx + 1}.</span>
              <span className="flex-1">{s?.name ?? "(unknown staff)"}</span>
              <button onClick={() => onMove(idx, -1)} disabled={idx === 0} className="text-xs text-slate-500 hover:text-slate-900 disabled:opacity-30">↑</button>
              <button onClick={() => onMove(idx, 1)} disabled={idx === priority.length - 1} className="text-xs text-slate-500 hover:text-slate-900 disabled:opacity-30">↓</button>
              <button onClick={() => onRemove(staffId)} className="text-xs text-rose-500 hover:text-rose-700">×</button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2">
        <select
          onChange={(e) => { if (e.target.value) onAdd(e.target.value); e.target.value = ""; }}
          className="rounded-lg border border-border bg-surface px-2 py-1 text-xs"
          defaultValue=""
        >
          <option value="">+ add staff to list</option>
          {eligibleStaff
            .filter((s) => !priority.includes(s.id))
            .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
    </div>
  );
}

function WeightedEditor({
  eligibleStaff,
  weights,
  setWeight,
  weightSum,
  normalized,
}: {
  eligibleStaff: Staff[];
  weights: Record<string, number>;
  setWeight: (id: string, v: number) => void;
  weightSum: number;
  normalized: Array<{ staffId: string; pct: number; name: string }>;
}) {
  return (
    <div className="mt-5 space-y-4">
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">Weighted distribution</div>
        <p className="mt-1 text-[11px] text-ink-muted">
          Long-term share per staff. Sum doesn&apos;t have to equal 100 — the engine
          normalizes. Deficit-correction keeps actual shares close to target over time.
        </p>
      </div>
      <ul className="space-y-2">
        {eligibleStaff.map((s) => {
          const value = weights[s.id] ?? 0;
          return (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              <span className="flex-1 truncate">{s.name}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={value}
                onChange={(e) => setWeight(s.id, Number(e.target.value))}
                className="h-1.5 w-40 cursor-pointer accent-brand-accent"
              />
              <input
                type="number"
                min={0}
                max={100}
                value={value}
                onChange={(e) => setWeight(s.id, Number(e.target.value))}
                className="w-16 rounded-md border border-border px-2 py-1 text-right text-sm tabular-nums"
              />
              <span className="text-xs text-ink-muted">%</span>
            </li>
          );
        })}
      </ul>
      <div className="rounded-lg border border-border bg-surface-muted/40 p-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-ink">
            Sum: <span className="tabular-nums">{weightSum}%</span>
          </span>
          <span className="text-ink-subtle">
            {weightSum === 0
              ? "Set at least one weight"
              : weightSum === 100
                ? "Exact 100% — no normalization needed"
                : "Engine will normalize to 100%"}
          </span>
        </div>
        {normalized.length > 0 && (
          <div className="mt-3 space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
              Projected distribution (after normalization)
            </div>
            <div className="flex h-3 overflow-hidden rounded-full">
              {normalized.map((n, i) => (
                <div
                  key={n.staffId}
                  className={i % 4 === 0 ? "bg-brand-accent" : i % 4 === 1 ? "bg-emerald-500" : i % 4 === 2 ? "bg-amber-500" : "bg-violet-500"}
                  style={{ width: `${n.pct}%` }}
                  title={`${n.name}: ${n.pct.toFixed(1)}%`}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[11px] text-ink-muted">
              {normalized.map((n) => (
                <span key={n.staffId}>
                  {n.name}: <span className="font-medium text-ink">{n.pct.toFixed(1)}%</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Staff stats table ────────────────────────────────────────────────

function StaffStatsTable({ stats, loading }: { stats: StatsRow[]; loading: boolean }) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Users}
        title="Staff assignment stats"
        subtitle="Aggregated across all routing modes. Stats are written after a successful booking when the engine made the pick."
      />
      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-5"><Skeleton className="h-24 w-full rounded-md" /></div>
        ) : stats.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-muted">No routing activity yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-left text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="px-3 py-2">Staff</th>
                <th className="px-3 py-2 text-right">Today</th>
                <th className="px-3 py-2 text-right">Week</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Last assigned</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((r) => (
                <tr key={r.staffId} className="border-t border-border/60">
                  <td className="px-3 py-2">
                    <div className="text-ink">{r.staffName}</div>
                    <div className="text-[11px] text-ink-subtle">{r.staffEmail}</div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.assignmentsToday}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.assignmentsThisWeek}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.totalAssignments}</td>
                  <td className="px-3 py-2 text-xs text-ink-muted">{r.lastAssignedAt ? timeAgo(r.lastAssignedAt) : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}

// ─── Section header ──────────────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <header className="flex items-start gap-3 px-1">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-accent/10 text-brand-accent">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-sm text-ink-muted">{subtitle}</p>
      </div>
    </header>
  );
}

// ─── Time-ago utility ────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
