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
  Clock,
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
    /** Phase 15H — operational guidance for the "When should I use
     *  this?" expander. Concise. No marketing fluff. */
    bestFor: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  manual: {
    label: "Manual",
    plain: "Customers pick the staff member themselves on the booking page.",
    behavior: "The engine does not auto-assign. The booking page shows a staff picker.",
    example: "Customer selects Sarah → booking lands on Sarah.",
    fallback: "n/a — the customer is the picker.",
    bestFor:
      "High-touch consulting or partner-specific scheduling, where the customer needs to choose their specialist.",
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
    bestFor:
      "Fastest-response scheduling environments where the goal is to balance load so nobody is overwhelmed today.",
    icon: Scale,
  },
  round_robin: {
    label: "Round robin",
    plain: "Cycles through eligible staff by who was assigned the longest ago.",
    behavior:
      "Stable order: oldest lastAssignedAt first; ties by id ascending. Persistent across reschedules.",
    example: "Sarah was last assigned 11am, Mike 9am, Anna 8am → assigns Anna.",
    fallback: "Falls back to legacy round-robin if no rule is configured.",
    bestFor:
      "Equal lead distribution across teams over time. Fairest mode when every staff is equally qualified.",
    icon: Shuffle,
  },
  priority: {
    label: "Priority",
    plain: "Try staff in a fixed order; first eligible wins.",
    behavior:
      "Eligibility (working hours + freebusy + service pool) still applies — unavailable staff are skipped, not blocked.",
    example: "Priority list [Sarah, Mike, Anna]. Sarah busy, Mike free → assigns Mike.",
    fallback: "If everyone in the priority list is busy, falls through to no_pick_in_pool.",
    bestFor:
      "VIP handling, escalation queues, or any case where one staff member should always get first crack.",
    icon: ListChecks,
  },
  weighted: {
    label: "Weighted",
    plain: "Distribute by long-term percentage. Self-corrects drift over time.",
    behavior:
      "Deficit-correction algorithm: picks the staff most under-served vs. their target share. Tolerant of paused weights.",
    example: "Sarah 50%, Mike 30%, Anna 20%. Across 100 bookings → ~50/30/20 split.",
    fallback: "If all weighted staff are busy, falls through to no_available_staff.",
    bestFor:
      "Senior/junior balancing, controlled workload ratios, or onboarding new staff at a deliberately reduced share.",
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
  actualSharePct: number | null;
  expectedSharePct: number | null;
  driftPct: number | null;
  overloaded: boolean;
  expectedSource: "weighted_rule" | "equal_share" | "none";
};
type FairnessSummary = {
  rows: FairnessRow[];
  maxAbsoluteDriftPct: number | null;
  weeklyTotal: number;
  activeAssignees: number;
  hasHistory: boolean;
};

type SkippedCandidate = {
  staffId: string;
  staffName: string;
  reasonCode: string;
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
  /** Phase 15H — populated when booking POST captured the candidate
   *  pool. Empty for historical decisions made before this feature
   *  shipped. */
  skippedCandidates?: SkippedCandidate[];
  candidatePoolSize?: number;
  captured?: boolean;
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

type EligibilityReasonCode =
  | "in_service_pool"
  | "not_in_rule_pool"
  | "pto_override"
  | "outside_working_hours"
  | "no_schedule"
  | "internal_conflict"
  | "calendar_conflict"
  | "picked"
  | "not_picked";

type SimulationCandidate = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  status: "eligible" | "skipped" | "picked";
  reason: string;
  reasonCode: EligibilityReasonCode;
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
    skippedByPto: number;
    skippedByWorkingHours: number;
    skippedByInternalConflict: number;
    skippedByExternalBusy: number;
    skippedByRulePool: number;
  };
};

type CapacityRow = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  scheduledHours: number;
  bookedHours: number;
  remainingHours: number | null;
  utilization: number | null;
  overloaded: boolean;
  windowStart: string | null;
  windowEnd: string | null;
};
type CapacitySummary = {
  rows: CapacityRow[];
  totalRemainingHours: number;
  overloadedCount: number;
  closedCount: number;
  earliestWindowStart: string | null;
  latestWindowEnd: string | null;
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
  const [capacity, setCapacity] = React.useState<CapacitySummary | null>(null);
  const [activeScope, setActiveScope] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, statsRes, fairRes, decRes, warnRes, capRes] = await Promise.all([
        fetch("/api/tenant/routing-rules", { cache: "no-store" }),
        fetch("/api/tenant/routing-stats", { cache: "no-store" }),
        fetch("/api/tenant/routing/fairness", { cache: "no-store" }),
        fetch("/api/tenant/routing/decisions", { cache: "no-store" }),
        fetch("/api/tenant/routing/eligibility-warnings", { cache: "no-store" }),
        fetch("/api/tenant/routing/capacity", { cache: "no-store" }),
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
      if (capRes.ok) setCapacity(await capRes.json());
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
        capacity={capacity}
      />

      <RoutingModesOverview bootstrap={bootstrap} />

      <SimulationSection services={services} loading={loading} />

      <FairnessSection fairness={fairness} loading={loading} />

      <DecisionsSection decisions={decisions} loading={loading} />

      <CapacityForecastSection capacity={capacity} loading={loading} />

      <EligibilityWarningsSection warnings={warnings} loading={loading} />

      <FallbackPolicySection
        tenantDefault={tenantDefault}
        activeMode={bootstrap.hero.activeMode}
      />

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
  capacity,
}: {
  bootstrap: RoutingPageBootstrap;
  warnings: EligWarnings | null;
  fairness: FairnessSummary | null;
  decisions: DecisionsResp | null;
  capacity: CapacitySummary | null;
}) {
  const h = bootstrap.hero;
  const fairnessHealth = fairnessHealthStatus(fairness?.maxAbsoluteDriftPct ?? null);
  const queueBalancing = h.activeMode === "weighted" || h.activeMode === "round_robin";
  const allCalendarsConnected =
    h.eligibleStaffCount > 0 && h.calendarConnectedStaff >= h.eligibleStaffCount;
  const disconnectedCalendarCount = Math.max(0, h.eligibleStaffCount - h.calendarConnectedStaff);

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
              tooltip={`${h.eligibleStaffCount} staff in the workspace are eligible for engine assignment via working hours + service pool. Connecting a calendar is optional — staff stay eligible using workspace availability alone.`}
            />
            <HeroStat
              icon={CalendarCheck2}
              value={`${h.calendarConnectedStaff}`}
              label="Calendars connected"
              tooltip={
                h.calendarConnectedStaff === 0
                  ? "No staff have connected an external calendar. Routing still works using workspace working hours — but external busy time isn't subtracted from availability."
                  : `${h.calendarConnectedStaff} of ${h.eligibleStaffCount} staff have a connected calendar. External busy events are honored in eligibility for those staff.`
              }
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
          {/* Phase 15G health chips — real-state derived */}
          <OperationalChip
            label={
              allCalendarsConnected
                ? "All calendars connected"
                : disconnectedCalendarCount === 0
                  ? "No staff configured"
                  : `${disconnectedCalendarCount} calendar${disconnectedCalendarCount === 1 ? "" : "s"} disconnected`
            }
            status={
              allCalendarsConnected
                ? "ok"
                : disconnectedCalendarCount === 0
                  ? "muted"
                  : "degraded"
            }
            icon={CalendarCheck2}
            detail={
              allCalendarsConnected
                ? "Every active staff member has a calendar connection. External busy time is fully visible to the engine."
                : `${disconnectedCalendarCount} of ${h.eligibleStaffCount} staff don't have a calendar connection. External busy time is invisible to routing for those staff.`
            }
          />
          {(warnings?.counts.staffOnPtoToday ?? 0) > 0 && (
            <OperationalChip
              label={`${warnings!.counts.staffOnPtoToday} PTO override${warnings!.counts.staffOnPtoToday === 1 ? "" : "s"} today`}
              status="degraded"
              icon={CalendarX2}
              detail="Staff with unavailable overrides for today. Engine will skip them for any window."
            />
          )}
          {fairness && fairness.hasHistory && fairness.maxAbsoluteDriftPct !== null && fairness.maxAbsoluteDriftPct > 25 && (
            <OperationalChip
              label={`Fairness drift ${fairness.maxAbsoluteDriftPct.toFixed(0)}%`}
              status="degraded"
              icon={Scale}
              detail="At least one staff is significantly over or under their target share. Consider rebalancing weighted distribution."
            />
          )}
          {(capacity?.overloadedCount ?? 0) > 0 && (
            <OperationalChip
              label={`${capacity!.overloadedCount} staff overloaded`}
              status="down"
              icon={AlertTriangle}
              detail="Staff at ≥90% utilization for today. Engine eligibility may shrink as more bookings land."
            />
          )}
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
  tooltip,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  label: string;
  accent?: "default" | "rose" | "amber" | "emerald" | "muted";
  tooltip?: string;
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
    <div
      className="min-w-[88px] rounded-xl border border-border bg-surface px-2.5 py-2 text-left"
      title={tooltip}
    >
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

function fairnessHealthStatus(
  drift: number | null,
): { label: string; accent: "emerald" | "amber" | "rose" | "muted" } {
  // Null = no engine-driven history yet. Show neutral "—" not a false
  // "Healthy" badge.
  if (drift === null) return { label: "—", accent: "muted" };
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
                  <BestForExpander bestFor={meta.bestFor} />
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function BestForExpander({ bestFor }: { bestFor: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-ink-subtle hover:text-ink"
      >
        <span>When should I use this?</span>
        <span className={"transition-transform " + (open ? "rotate-90" : "")}>›</span>
      </button>
      {open && (
        <p className="mt-2 rounded-md bg-surface-muted/60 px-2 py-1.5 text-[11px] leading-relaxed text-ink-muted">
          {bestFor}
        </p>
      )}
    </div>
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

  // Phase 15G — cancel any in-flight simulation when the user clicks
  // again, so the last click wins and we don't paint stale results
  // from an earlier slower request.
  const inFlight = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    return () => {
      inFlight.current?.abort();
    };
  }, []);

  async function run() {
    if (!serviceId) {
      setError("Pick a service first.");
      return;
    }
    // Cancel any earlier request.
    inFlight.current?.abort();
    const ac = new AbortController();
    inFlight.current = ac;
    setRunning(true);
    setError(null);
    try {
      const startAt = new Date(`${date}T${time}:00`).toISOString();
      const res = await fetch("/api/tenant/routing/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId, startAt }),
        signal: ac.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Simulation failed");
      // Only paint if THIS request is still the in-flight one.
      if (inFlight.current === ac) setResult(data);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return; // superseded
      setError(e instanceof Error ? e.message : "Simulation failed");
      setResult(null);
    } finally {
      if (inFlight.current === ac) {
        setRunning(false);
        inFlight.current = null;
      }
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
  const isManual = decision.mode === "manual" || decision.mode === "no_rule";
  const winner = decision.ok
    ? result.candidates.find((c) => c.staffId === decision.staffId) ?? null
    : null;
  return (
    <div className="mt-5 space-y-3">
      {/* Decision banner */}
      <DecisionBanner
        isOk={isOk}
        isManual={isManual}
        decision={decision}
        winner={winner}
        ruleScope={result.rule.scope}
      />

      {/* Phase 15H — counts strip. Always show In pool + Eligible.
          Hide zero-count skip categories so the strip doesn't shout
          "0 0 0 0 0" when nothing was filtered. */}
      <CountChipsStrip counts={result.counts} />

      {/* Candidate list with rich reason badges */}
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
                  <CandidateStatusPill status={c.status} />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <ReasonBadge code={c.reasonCode} />
                    <span className="text-xs text-ink-muted">{c.reason}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DecisionBanner({
  isOk,
  isManual,
  decision,
  winner,
  ruleScope,
}: {
  isOk: boolean;
  isManual: boolean;
  decision: SimulationResp["decision"];
  winner: SimulationCandidate | null;
  ruleScope: "service" | "tenant_default" | "none";
}) {
  // Phase 15G fix: Manual mode is INTENTIONAL, not a failure. Render
  // a neutral informational banner — not the amber "no assignment"
  // warning that previously surfaced as a bug.
  if (isManual && !isOk) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50/70 p-4">
        <div className="mt-0.5">
          <Info className="h-5 w-5 text-sky-600" />
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-semibold text-sky-900">
            Customer chooses the staff member manually
          </p>
          <p className="mt-0.5 text-xs text-sky-800">
            No automatic assignment occurs in Manual mode. The booking page renders a
            staff picker and the engine intentionally returns no decision here.
          </p>
        </div>
        <div className="hidden text-right text-[10px] font-medium uppercase tracking-wide text-ink-subtle sm:block">
          {ruleScope === "service"
            ? "service-specific rule"
            : ruleScope === "tenant_default"
              ? "tenant default rule"
              : "no rule"}
        </div>
      </div>
    );
  }

  return (
    <div
      className={
        "flex items-start gap-3 rounded-xl border p-4 " +
        (isOk ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50")
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
            <p className="font-semibold text-amber-900">
              No assignment would be made
            </p>
            <p className="mt-0.5 text-xs text-amber-800">
              {decision.mode} → {decision.reason}
            </p>
          </>
        )}
      </div>
      <div className="hidden text-right text-[10px] font-medium uppercase tracking-wide text-ink-subtle sm:block">
        {ruleScope === "service"
          ? "service-specific rule"
          : ruleScope === "tenant_default"
            ? "tenant default rule"
            : "no rule"}
      </div>
    </div>
  );
}

function CandidateStatusPill({ status }: { status: SimulationCandidate["status"] }) {
  if (status === "picked") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <CheckCircle2 className="h-3 w-3" /> Picked
      </span>
    );
  }
  if (status === "eligible") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">
        <ShieldCheck className="h-3 w-3" /> Eligible
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
      <XCircle className="h-3 w-3" /> Skipped
    </span>
  );
}

function ReasonBadge({ code }: { code: EligibilityReasonCode }) {
  const meta = REASON_META[code];
  const Icon = meta.icon;
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium " +
        meta.classes
      }
      title={meta.tooltip}
    >
      <Icon className="h-2.5 w-2.5" />
      {meta.label}
    </span>
  );
}

const REASON_META: Record<
  EligibilityReasonCode,
  {
    label: string;
    tooltip: string;
    icon: React.ComponentType<{ className?: string }>;
    classes: string;
  }
> = {
  in_service_pool: {
    label: "in pool",
    tooltip: "Listed in this service's staff pool.",
    icon: Users,
    classes: "border-sky-200 bg-sky-50 text-sky-700",
  },
  not_in_rule_pool: {
    label: "not in rule pool",
    tooltip: "This staff member is not listed in the priority / weighted rule pool.",
    icon: ListChecks,
    classes: "border-slate-200 bg-slate-100 text-slate-600",
  },
  pto_override: {
    label: "PTO override",
    tooltip: "Staff has an unavailable=true override for this date in availability_overrides.",
    icon: CalendarX2,
    classes: "border-violet-200 bg-violet-50 text-violet-700",
  },
  outside_working_hours: {
    label: "outside hours",
    tooltip: "Working schedule exists but doesn't cover the requested window.",
    icon: Clock,
    classes: "border-slate-200 bg-slate-100 text-slate-600",
  },
  no_schedule: {
    label: "no schedule",
    tooltip: "No weekly availability row configured for this day of the week.",
    icon: CalendarX2,
    classes: "border-slate-200 bg-slate-100 text-slate-600",
  },
  internal_conflict: {
    label: "internal conflict",
    tooltip: "Already has a confirmed booking that overlaps this window.",
    icon: XCircle,
    classes: "border-rose-200 bg-rose-50 text-rose-700",
  },
  calendar_conflict: {
    label: "calendar conflict",
    tooltip: "Connected external calendar has a busy event in this window.",
    icon: CalendarX2,
    classes: "border-amber-200 bg-amber-50 text-amber-800",
  },
  picked: {
    label: "picked",
    tooltip: "The picker chose this staff member.",
    icon: CheckCircle2,
    classes: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  not_picked: {
    label: "not picked",
    tooltip: "Eligible — but the picker selected a different staff member this round.",
    icon: ShieldCheck,
    classes: "border-sky-200 bg-sky-50 text-sky-700",
  },
};

function CountChipsStrip({
  counts,
}: {
  counts: SimulationResp["counts"];
}) {
  // Always show "In pool" + "Eligible" — they anchor the strip even
  // when zero. Skip categories appear only when count > 0 so the
  // strip stays informational, not noisy.
  type Skip = { label: string; value: number; tone: "violet" | "muted" };
  const skips: Skip[] = (
    [
      { label: "PTO override", value: counts.skippedByPto, tone: "violet" },
      { label: "Outside working hours", value: counts.skippedByWorkingHours, tone: "muted" },
      { label: "Internal conflict", value: counts.skippedByInternalConflict, tone: "muted" },
      { label: "Calendar conflict", value: counts.skippedByExternalBusy, tone: "muted" },
      { label: "Not in rule pool", value: counts.skippedByRulePool, tone: "muted" },
    ] as Skip[]
  ).filter((s) => s.value > 0);

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <CountChip label="In pool" value={counts.inPool} />
      <CountChip label="Eligible" value={counts.eligible} tone="emerald" />
      {skips.map((s) => (
        <CountChip key={s.label} label={s.label} value={s.value} tone={s.tone} />
      ))}
      {skips.length === 0 && counts.inPool > 0 && counts.inPool === counts.eligible && (
        <span className="text-[11px] text-ink-subtle">
          No staff filtered — every candidate in the pool was eligible.
        </span>
      )}
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
  tone?: "default" | "emerald" | "muted" | "violet";
}) {
  const styles =
    tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "violet"
        ? "border-violet-200 bg-violet-50 text-violet-700"
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
  // Phase 15G: when there's no engine-driven history, render an
  // explicit empty state instead of a table of fabricated -100% drift
  // values. Customer-picked bookings are NOT counted toward fairness
  // — see lib/routing/fairness.ts.
  const showEmpty = !loading && fairness && !fairness.hasHistory;

  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Scale}
        title="Fairness + workload analytics"
        subtitle="Per-staff weekly load with drift vs. target share. Only engine-driven assignments count — customer-picked and manual-mode bookings are excluded."
      />
      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="p-5"><Skeleton className="h-32 w-full rounded-md" /></div>
        ) : !fairness || fairness.rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-ink-muted">No staff to analyze yet.</div>
        ) : showEmpty ? (
          <div className="flex flex-col items-center gap-2 p-8 text-center">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-surface-muted text-ink-subtle">
              <Scale className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-ink">No routing history yet</p>
            <p className="max-w-md text-xs text-ink-muted">
              Fairness metrics appear after the engine has assigned at least one
              booking. Customer-picked and manual-mode bookings are intentionally
              excluded — they have no engine decision to evaluate.
            </p>
            <div className="mt-2 w-full max-w-md overflow-hidden rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-surface-muted text-left font-semibold uppercase tracking-wide text-ink-subtle">
                  <tr>
                    <th className="px-3 py-2">Staff</th>
                    <th className="px-3 py-2 text-right">Total lifetime</th>
                  </tr>
                </thead>
                <tbody>
                  {fairness.rows.map((r) => (
                    <tr key={r.staffId} className="border-t border-border/60">
                      <td className="px-3 py-2 text-left text-ink">{r.staffName}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">{r.totalAssignments}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
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
                const drift = r.driftPct;
                const driftTone = drift === null
                  ? "muted"
                  : Math.abs(drift) <= 10
                    ? "emerald"
                    : Math.abs(drift) <= 25
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
                    <td className="px-3 py-2 text-right tabular-nums">
                      {r.actualSharePct === null ? "—" : `${r.actualSharePct.toFixed(1)}%`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-subtle">
                      {r.expectedSharePct === null ? "—" : `${r.expectedSharePct.toFixed(1)}%`}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {drift === null ? (
                        <span className="text-[11px] text-ink-subtle">—</span>
                      ) : (
                        <span
                          className={
                            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium " +
                            (driftTone === "emerald"
                              ? "bg-emerald-50 text-emerald-700"
                              : driftTone === "amber"
                                ? "bg-amber-50 text-amber-800"
                                : driftTone === "rose"
                                  ? "bg-rose-50 text-rose-700"
                                  : "bg-slate-100 text-slate-600")
                          }
                        >
                          {drift > 0 ? "+" : ""}
                          {drift.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {r.actualSharePct !== null && r.expectedSharePct !== null ? (
                        <DriftBar actual={r.actualSharePct} target={r.expectedSharePct} />
                      ) : (
                        <span className="text-[11px] text-ink-subtle">—</span>
                      )}
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
                        {r.expectedSource === "weighted_rule" && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                            weighted target
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
      {fairness && fairness.hasHistory && fairness.maxAbsoluteDriftPct !== null && (
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
              <DecisionRowCard key={d.id} decision={d} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

function DecisionRowCard({ decision: d }: { decision: DecisionRow }) {
  const skipped = d.skippedCandidates ?? [];
  const reasonLabel = (code: string): string => {
    switch (code) {
      case "pto_override": return "PTO override";
      case "outside_working_hours": return "outside hours";
      case "no_schedule": return "no schedule";
      case "internal_conflict": return "internal conflict";
      case "calendar_conflict": return "calendar conflict";
      case "not_in_rule_pool": return "not in rule pool";
      case "not_picked": return "not picked";
      default: return code;
    }
  };
  return (
    <li className="flex items-start gap-3 p-4 text-sm">
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
        {/* Phase 15H — skipped staff list. Populated for decisions
            made AFTER the candidate-pool capture feature shipped;
            absent for historical decisions. */}
        {skipped.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-surface-muted/60 px-2 py-1.5 text-[11px] text-ink-muted">
            <span className="font-semibold text-ink-subtle">Skipped:</span>
            {skipped.map((s) => (
              <span
                key={s.staffId}
                className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-surface px-1.5 py-0.5"
                title={`Reason: ${reasonLabel(s.reasonCode)}`}
              >
                <XCircle className="h-2.5 w-2.5 text-slate-400" />
                {s.staffName}
                <span className="text-[10px] text-ink-subtle">· {reasonLabel(s.reasonCode)}</span>
              </span>
            ))}
          </div>
        )}
        {!d.captured && (d.candidatePoolSize === undefined || d.candidatePoolSize === 0) && (
          <div className="mt-2 text-[11px] text-ink-subtle">
            (candidate pool not captured for this booking)
          </div>
        )}
      </div>
      <div className="text-right text-[11px] text-ink-subtle">{timeAgo(d.at)}</div>
    </li>
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
    // Phase 15G: weighted mode requires sum === 100 before saving.
    // The engine normalizes anyway, but enforcing 100 keeps the
    // displayed weights honest with what the engine sees.
    if (mode === "weighted") {
      const sum = Object.values(weights).reduce((a, b) => a + b, 0);
      if (sum !== 100) {
        toast(`Weighted distribution must total 100% (currently ${sum}%). Use "Normalize to 100%" to balance.`, "error");
        return;
      }
    }
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

  function normalizeWeightsTo100() {
    setWeights((cur) => {
      const ids = Object.keys(cur);
      if (ids.length === 0) return cur;
      const sum = Object.values(cur).reduce((a, b) => a + b, 0);
      if (sum === 0) {
        // Equal split across all listed staff.
        const each = Math.floor(100 / ids.length);
        const next: Record<string, number> = {};
        ids.forEach((id, i) => { next[id] = i === 0 ? 100 - each * (ids.length - 1) : each; });
        return next;
      }
      // Scale + round; assign rounding residual to the largest weight.
      const scaled = ids.map((id) => ({ id, raw: (cur[id] / sum) * 100 }));
      const rounded = scaled.map((s) => ({ id: s.id, val: Math.round(s.raw) }));
      const drift = 100 - rounded.reduce((a, b) => a + b.val, 0);
      if (drift !== 0) {
        const biggest = rounded.slice().sort((a, b) => b.val - a.val)[0];
        biggest.val += drift;
      }
      const next: Record<string, number> = {};
      for (const r of rounded) next[r.id] = Math.max(0, r.val);
      return next;
    });
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
            onNormalize={normalizeWeightsTo100}
          />
        )}

        {/* Phase 15G — inline plan-lock CTA when the selected mode
            isn't included on the current plan. The PUT endpoint
            still accepts any mode (preserving existing behavior),
            but the UI surfaces the upgrade pathway clearly. */}
        {!bootstrap.canUseMode[mode] && (
          <PlanLockedNotice
            mode={mode}
            requiredPlan={bootstrap.planByMode[mode]}
            planName={bootstrap.plan.name}
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
  onNormalize,
}: {
  eligibleStaff: Staff[];
  weights: Record<string, number>;
  setWeight: (id: string, v: number) => void;
  weightSum: number;
  normalized: Array<{ staffId: string; pct: number; name: string }>;
  onNormalize: () => void;
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-ink">
            Sum: <span className={"tabular-nums " + (weightSum === 100 ? "text-emerald-700" : weightSum === 0 ? "text-ink-subtle" : "text-amber-700")}>{weightSum}%</span>
          </span>
          <div className="flex items-center gap-2">
            <span className={"text-[11px] " + (weightSum === 100 ? "text-emerald-700" : weightSum === 0 ? "text-ink-subtle" : "text-amber-700")}>
              {weightSum === 0
                ? "Set at least one weight"
                : weightSum === 100
                  ? "Ready to save"
                  : "Must total 100% to save"}
            </span>
            {weightSum !== 100 && weightSum !== 0 && (
              <button
                type="button"
                onClick={onNormalize}
                className="rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-ink hover:bg-surface-muted"
              >
                Normalize to 100%
              </button>
            )}
          </div>
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

// ─── Capacity forecasting ────────────────────────────────────────────

function CapacityForecastSection({
  capacity,
  loading,
}: {
  capacity: CapacitySummary | null;
  loading: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={Target}
        title="Capacity forecast (rest of today)"
        subtitle="Per-staff remaining working time today, derived from working hours + confirmed bookings. External calendar busy time isn't subtracted here — connected calendars still gate routing decisions."
      />
      {loading ? (
        <Card className="p-5"><Skeleton className="h-32 w-full rounded-md" /></Card>
      ) : !capacity || capacity.rows.length === 0 ? (
        <Card className="p-6 text-center text-sm text-ink-muted">
          No staff configured yet.
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <CapacityStat
              icon={Clock}
              label="Total remaining hours"
              value={`${capacity.totalRemainingHours.toFixed(1)}h`}
              tone={capacity.totalRemainingHours > 0 ? "default" : "muted"}
            />
            <CapacityStat
              icon={AlertTriangle}
              label="Overloaded staff"
              value={String(capacity.overloadedCount)}
              tone={capacity.overloadedCount > 0 ? "rose" : "muted"}
            />
            <CapacityStat
              icon={CalendarX2}
              label="Closed today"
              value={String(capacity.closedCount)}
              tone="muted"
            />
          </div>
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                <tr>
                  <th className="px-3 py-2">Staff</th>
                  <th className="px-3 py-2 text-right">Scheduled</th>
                  <th className="px-3 py-2 text-right">Booked</th>
                  <th className="px-3 py-2 text-right">Remaining</th>
                  <th className="px-3 py-2 text-right">Utilization</th>
                  <th className="px-3 py-2">Window</th>
                </tr>
              </thead>
              <tbody>
                {capacity.rows.map((r) => {
                  const utilPct = r.utilization === null ? null : Math.round(r.utilization * 100);
                  const utilTone =
                    utilPct === null
                      ? "muted"
                      : utilPct >= 90
                        ? "rose"
                        : utilPct >= 70
                          ? "amber"
                          : "emerald";
                  const utilClasses =
                    utilTone === "rose"
                      ? "bg-rose-50 text-rose-700"
                      : utilTone === "amber"
                        ? "bg-amber-50 text-amber-800"
                        : utilTone === "emerald"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-100 text-slate-600";
                  return (
                    <tr key={r.staffId} className="border-t border-border/60">
                      <td className="px-3 py-2">
                        <div className="text-ink">{r.staffName}</div>
                        <div className="text-[11px] text-ink-subtle">{r.staffEmail}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.scheduledHours > 0 ? `${r.scheduledHours.toFixed(1)}h` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.bookedHours > 0 ? `${r.bookedHours.toFixed(1)}h` : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.remainingHours === null ? (
                          <span className="text-ink-subtle">closed</span>
                        ) : (
                          `${r.remainingHours.toFixed(1)}h`
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {utilPct === null ? (
                          <span className="text-[11px] text-ink-subtle">—</span>
                        ) : (
                          <span
                            className={
                              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium " +
                              utilClasses
                            }
                          >
                            {utilPct}%
                            {r.overloaded && <AlertTriangle className="h-2.5 w-2.5" />}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-ink-muted">
                        {r.windowStart && r.windowEnd
                          ? `${formatTime(r.windowStart)} – ${formatTime(r.windowEnd)}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </section>
  );
}

function CapacityStat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "default" | "rose" | "amber" | "muted";
}) {
  const valueClass =
    tone === "rose" ? "text-rose-700" : tone === "amber" ? "text-amber-700" : tone === "muted" ? "text-ink-subtle" : "text-ink";
  return (
    <Card className="flex items-start gap-3 p-4">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className={"text-lg font-semibold tabular-nums " + valueClass}>{value}</div>
        <div className="text-[11px] text-ink-muted">{label}</div>
      </div>
    </Card>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ─── Fallback policy (read-only) ─────────────────────────────────────

function FallbackPolicySection({
  tenantDefault,
  activeMode,
}: {
  tenantDefault: Rule | null;
  activeMode: string;
}) {
  // The engine's fallback chain is hardcoded today (no per-tenant
  // configuration). This section surfaces exactly what /api/bookings
  // does today so admins can see the contract without us shipping a
  // toggle that the engine wouldn't honor.
  const lines: Array<{ when: string; then: string; tone: "default" | "amber" | "rose" }> = [];
  if (activeMode === "manual") {
    lines.push({
      when: "Manual mode is active",
      then: "Customer picks staff on the booking page. Engine does not auto-assign.",
      tone: "default",
    });
  } else if (tenantDefault && !tenantDefault.enabled) {
    lines.push({
      when: "Tenant default rule is disabled",
      then: "Engine falls back to the legacy round-robin path used before routing rules shipped.",
      tone: "amber",
    });
  } else if (!tenantDefault) {
    lines.push({
      when: "No tenant default rule configured",
      then: "Engine falls back to the legacy round-robin path used before routing rules shipped.",
      tone: "amber",
    });
  }
  lines.push({
    when: "No eligible staff for the requested window",
    then: "Booking fails with no_available_staff. The public booking page surfaces this as 'no availability'.",
    tone: "rose",
  });
  lines.push({
    when: "Picker returns no choice (priority/weighted with all unavailable)",
    then: "Booking fails with no_pick_in_pool. Same UI treatment as no_available_staff.",
    tone: "rose",
  });
  lines.push({
    when: "Engine throws an unexpected error",
    then: "Falls back to legacy round-robin so the booking still completes (defense in depth).",
    tone: "default",
  });

  return (
    <section className="space-y-3">
      <SectionHeader
        icon={GitBranch}
        title="Fallback policy (current engine behavior)"
        subtitle="What happens when the primary routing decision can't be made. Hardcoded in the engine — read-only on this page."
      />
      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-border/60">
          {lines.map((line, idx) => (
            <li key={idx} className="flex items-start gap-3 p-4 text-sm">
              <div
                className={
                  "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg " +
                  (line.tone === "rose"
                    ? "bg-rose-50 text-rose-700"
                    : line.tone === "amber"
                      ? "bg-amber-50 text-amber-700"
                      : "bg-surface-muted text-ink-subtle")
                }
              >
                <ArrowRight className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium text-ink">{line.when}</p>
                <p className="mt-0.5 text-xs text-ink-muted">{line.then}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

// ─── Plan-locked inline notice ───────────────────────────────────────

function PlanLockedNotice({
  mode,
  requiredPlan,
  planName,
}: {
  mode: string;
  requiredPlan: string;
  planName: string;
}) {
  const meta = MODE_META[mode as Mode];
  const modeLabel = meta?.label ?? mode;
  const tierLabel = requiredPlan.charAt(0).toUpperCase() + requiredPlan.slice(1);
  return (
    <div className="mt-5 flex flex-wrap items-start gap-3 rounded-xl border border-violet-200 bg-violet-50/70 p-4">
      <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet-100 text-violet-700">
        <Lock className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-violet-900">
          {modeLabel} routing requires the {tierLabel} plan
        </p>
        <p className="mt-0.5 text-xs text-violet-800">
          You&apos;re currently on the <span className="font-medium">{planName}</span> plan.
          Existing rules using this mode continue to work — the platform never
          retroactively breaks routing — but new tenants on lower tiers are
          steered toward {tierLabel}+ for this capability.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/pricing"
          className="inline-flex items-center gap-1 rounded-lg border border-violet-200 bg-surface px-2.5 py-1.5 text-xs font-medium text-violet-800 hover:bg-violet-100"
        >
          Compare plans <ExternalLink className="h-3 w-3" />
        </Link>
        <Link
          href="/dashboard/billing"
          className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-violet-700"
        >
          Upgrade
        </Link>
      </div>
    </div>
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
