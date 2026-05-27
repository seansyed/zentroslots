"use client";

import * as React from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Cog,
  Hourglass,
  PauseCircle,
  Play,
  Plus,
  Repeat,
  Search,
  Shield,
  Sparkles,
  Trash2,
  Users,
  X,
  XCircle,
} from "lucide-react";

import { Badge, Button, Card, Skeleton, toast, confirmAction } from "@/components/ui/primitives";
import { useCapability } from "@/components/billing/CapabilityProvider";
import {
  PremiumLockedExperience,
  RecurringSchedulingPreview,
} from "@/components/billing/PremiumLockedExperience";
import Link from "next/link";
import { Lock, TrendingUp, Heart, Zap } from "lucide-react";

// ─── Types (unchanged contract with /api/tenant/booking-series) ───────

// ─── Types (unchanged contract with /api/tenant/booking-series) ───────

type Series = {
  id: string;
  serviceId: string;
  staffUserId: string | null;
  customerName: string;
  customerEmail: string;
  recurrenceRule: string;
  startLocal: string;
  timezone: string;
  endDate: string | null;
  occurrenceCount: number | null;
  status: string;
  lastMaterializedIndex: number;
  createdAt: string;
  updatedAt: string;
  serviceName: string | null;
  staffName: string | null;
};

type Service = { id: string; name: string };
type Staff = { id: string; name: string; timezone: string };

type Occurrence = {
  id: string;
  occurrenceIndex: number;
  occurrenceStartAt: string;
  status: string;
  bookingId: string | null;
  failureReason: string | null;
  attempts: number;
  overrides: Record<string, unknown>;
};

type ApiData = { series: Series[]; services: Service[]; staff: Staff[] };

// ─── Status visual taxonomy ──────────────────────────────────────────

const SERIES_STATUS_META: Record<string, { label: string; classes: string; dot: string }> = {
  active: { label: "Active", classes: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  paused: { label: "Paused", classes: "bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  cancelled: { label: "Cancelled", classes: "bg-rose-50 text-rose-700", dot: "bg-rose-500" },
  completed: { label: "Completed", classes: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
};

const OCC_STATUS_META: Record<string, { label: string; classes: string; icon: React.ComponentType<{ className?: string }> }> = {
  scheduled: { label: "Scheduled", classes: "bg-sky-50 text-sky-700", icon: Hourglass },
  completed: { label: "Completed", classes: "bg-emerald-50 text-emerald-700", icon: CheckCircle2 },
  cancelled: { label: "Cancelled", classes: "bg-rose-50 text-rose-700", icon: X },
  skipped: { label: "Skipped", classes: "bg-slate-100 text-slate-600", icon: ChevronRight },
  failed: { label: "Failed", classes: "bg-rose-50 text-rose-700", icon: AlertCircle },
};

type StatusFilter = "all" | "active" | "paused" | "cancelled" | "completed";

// ─── Root ─────────────────────────────────────────────────────────────

export default function RecurringClient() {
  const [data, setData] = React.useState<ApiData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [openSeriesId, setOpenSeriesId] = React.useState<string | null>(null);

  // Filters (Phase 12)
  const [filter, setFilter] = React.useState<StatusFilter>("all");
  const [serviceFilter, setServiceFilter] = React.useState<string>("all");
  const [staffFilter, setStaffFilter] = React.useState<string>("all");
  const [cadenceFilter, setCadenceFilter] = React.useState<"all" | "DAILY" | "WEEKLY" | "MONTHLY">("all");
  const [search, setSearch] = React.useState("");

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/tenant/booking-series", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load", "error");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { refresh(); }, [refresh]);

  async function actionSeries(id: string, action: "pause" | "resume" | "cancel") {
    if (action === "cancel") {
      const ok = await confirmAction({
        title: "Cancel this recurring series?",
        body: "Already-booked occurrences stay on the calendar. Cancel them individually if needed.",
        variant: "danger",
        confirmLabel: "Cancel series",
        cancelLabel: "Keep it",
      });
      if (!ok) return;
    }
    try {
      const res = await fetch("/api/tenant/booking-series", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast(`Series ${action === "cancel" ? "cancelled" : action + "d"}`, "success");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    }
  }

  const metrics = React.useMemo(() => deriveMetrics(data), [data]);

  const filtered = React.useMemo(() => {
    if (!data) return [] as Series[];
    let rows = data.series;
    if (filter !== "all") rows = rows.filter((s) => s.status === filter);
    if (serviceFilter !== "all") rows = rows.filter((s) => s.serviceId === serviceFilter);
    if (staffFilter !== "all") rows = rows.filter((s) => s.staffUserId === staffFilter);
    if (cadenceFilter !== "all") {
      rows = rows.filter((s) => parseFreq(s.recurrenceRule) === cadenceFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (s) =>
          s.customerName.toLowerCase().includes(q) ||
          s.customerEmail.toLowerCase().includes(q) ||
          (s.serviceName ?? "").toLowerCase().includes(q),
      );
    }
    return rows;
  }, [data, filter, serviceFilter, staffFilter, cadenceFilter, search]);

  // ── Plan capability gate (Phase 6 — Free-plan UI lockdown) ──────────
  // Three render branches:
  //   1. cap.allowed → normal premium UX
  //   2. !cap.allowed AND no grandfathered series → full locked page
  //   3. !cap.allowed AND grandfathered series exist → series visible
  //      read-only with banner; ALL mutation surfaces disabled.
  // The backend already 402s every mutation route — the UI mirroring
  // is purely about not letting the operator find a button that will
  // fail. Grandfather semantics preserved (existing rows continue to
  // materialize via the cron until enforcement orchestrator pauses).
  const cap = useCapability("recurring_series");
  const seriesCount = data?.series.length ?? 0;
  const actionsDisabled = !cap.allowed;

  // Branch 2 — full locked page state for Free tenants with nothing
  // grandfathered. Render the LockedFeatureCard primitive instead of
  // the operational dashboard.
  if (!cap.allowed && !loading && seriesCount === 0) {
    return (
      <div className="mt-6 space-y-6 pb-12">
        <LockedRecurringPage cap={cap} />
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6 pb-12">
      {/* Grandfather banner — branch 3 only. Appears above the page
          chrome so admins immediately understand WHY their action
          buttons are disabled before they try to click. */}
      {!cap.allowed && seriesCount > 0 && (
        <GrandfatherBanner cap={cap} count={seriesCount} />
      )}

      <Hero
        metrics={metrics}
        onCreate={() => setCreating(true)}
        loading={loading}
        onRefresh={refresh}
        actionsDisabled={actionsDisabled}
      />

      <KpiStrip metrics={metrics} loading={loading} />

      <EngineBehaviorCard />

      {/* CreateSeriesCard mount is hard-gated: even if a future code
          path flipped `creating=true` (e.g., a stale local-storage
          flag), capability-denied tenants never see the form. */}
      {creating && data && cap.allowed && (
        <CreateSeriesCard
          services={data.services}
          staff={data.staff}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); refresh(); }}
        />
      )}

      <FiltersBar
        filter={filter}
        setFilter={setFilter}
        services={data?.services ?? []}
        staff={data?.staff ?? []}
        serviceFilter={serviceFilter}
        setServiceFilter={setServiceFilter}
        staffFilter={staffFilter}
        setStaffFilter={setStaffFilter}
        cadenceFilter={cadenceFilter}
        setCadenceFilter={setCadenceFilter}
        search={search}
        setSearch={setSearch}
        counts={metrics.counts}
      />

      <SeriesListSection
        series={filtered}
        totalSeries={data?.series.length ?? 0}
        loading={loading}
        openSeriesId={openSeriesId}
        setOpenSeriesId={setOpenSeriesId}
        onAction={actionSeries}
        onRefresh={refresh}
        onCreate={() => setCreating(true)}
        actionsDisabled={actionsDisabled}
      />
    </div>
  );
}

// ─── Hero (Phase 1) ───────────────────────────────────────────────────

function Hero({
  metrics,
  onCreate,
  loading,
  onRefresh,
  actionsDisabled,
}: {
  metrics: Metrics;
  onCreate: () => void;
  loading: boolean;
  onRefresh: () => void;
  actionsDisabled?: boolean;
}) {
  const engineActive = metrics.counts.active > 0;
  return (
    <Card className="overflow-hidden p-0">
      <div className="bg-gradient-to-br from-brand-accent/8 via-surface to-surface px-6 py-7">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-brand-accent/10 text-brand-accent">
              <Repeat className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand-accent">
                  <Sparkles className="h-3 w-3" /> Subscription scheduling
                </span>
                <span
                  className={
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold " +
                    (engineActive
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-slate-100 text-slate-600")
                  }
                >
                  <span
                    className={
                      "h-1.5 w-1.5 rounded-full " +
                      (engineActive ? "animate-pulse bg-emerald-500" : "bg-slate-400")
                    }
                  />
                  {engineActive
                    ? `${metrics.counts.active} active series`
                    : "Engine idle"}
                </span>
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
                Recurring Scheduling
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
                Automate repeat appointments while intelligently respecting
                availability, buffers, and booking policies. Occurrences are
                materialized into real bookings ahead of time and validated
                against every other workspace rule.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
            >
              <Cog className={"h-3.5 w-3.5 " + (loading ? "animate-spin" : "")} />
              Refresh
            </button>
            {actionsDisabled ? (
              <Link
                href="/dashboard/billing"
                className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
                title="Upgrade to Pro to create recurring series"
              >
                <Lock className="h-3.5 w-3.5" /> Upgrade to create
              </Link>
            ) : (
              <Button onClick={onCreate}>
                <Plus className="mr-1 h-3.5 w-3.5" /> New series
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── KPI strip (Phase 2 — REAL data only) ────────────────────────────

function KpiStrip({ metrics, loading }: { metrics: Metrics; loading: boolean }) {
  const items = [
    {
      icon: CalendarClock,
      label: "Active series",
      value: String(metrics.counts.active),
      tone: metrics.counts.active > 0 ? "emerald" : "muted",
      hint: "Currently auto-generating",
    },
    {
      icon: PauseCircle,
      label: "Paused",
      value: String(metrics.counts.paused),
      tone: metrics.counts.paused > 0 ? "amber" : "muted",
      hint: "No new occurrences",
    },
    {
      icon: Hourglass,
      label: "Upcoming",
      value: String(metrics.upcomingOccurrences),
      tone: metrics.upcomingOccurrences > 0 ? "sky" : "muted",
      hint: "Scheduled in next 30 days",
    },
    {
      icon: CheckCircle2,
      label: "Booked this month",
      value: String(metrics.bookedThisMonth),
      tone: metrics.bookedThisMonth > 0 ? "emerald" : "muted",
      hint: "Occurrences materialized",
    },
    {
      icon: AlertCircle,
      label: "Failed generations",
      value: String(metrics.failedOccurrences),
      tone: metrics.failedOccurrences > 0 ? "rose" : "muted",
      hint: "Need review (last 90 days)",
    },
  ] as const;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      {items.map((it) => (
        <KpiCard
          key={it.label}
          icon={it.icon}
          label={it.label}
          value={loading ? "…" : it.value}
          tone={it.tone}
          hint={it.hint}
        />
      ))}
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  tone,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "default" | "sky" | "amber" | "emerald" | "rose" | "muted";
  hint: string;
}) {
  const valueTone =
    tone === "sky"
      ? "text-sky-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "emerald"
          ? "text-emerald-700"
          : tone === "rose"
            ? "text-rose-700"
            : tone === "muted"
              ? "text-ink-subtle"
              : "text-ink";
  const iconWrap =
    tone === "sky"
      ? "bg-sky-50 text-sky-600"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700"
        : tone === "emerald"
          ? "bg-emerald-50 text-emerald-700"
          : tone === "rose"
            ? "bg-rose-50 text-rose-700"
            : "bg-brand-accent/10 text-brand-accent";
  return (
    <Card className="flex items-start gap-3 p-4 transition-shadow duration-150 hover:shadow-md">
      <div className={"grid h-9 w-9 shrink-0 place-items-center rounded-lg " + iconWrap}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className={"text-xl font-semibold tabular-nums " + valueTone}>{value}</div>
        <div className="mt-0.5 text-[11px] font-medium text-ink">{label}</div>
        <div className="text-[10px] text-ink-subtle">{hint}</div>
      </div>
    </Card>
  );
}

// ─── Engine behavior card (read-only, honest) ────────────────────────

function EngineBehaviorCard() {
  const rows: Array<{
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    value: string;
    detail: string;
  }> = [
    {
      icon: CalendarRange,
      label: "Generation window",
      value: "Next 30 days",
      detail: "The cron worker generates occurrence rows for each active series 30 days ahead.",
    },
    {
      icon: Clock,
      label: "Materialization horizon",
      value: "Next 24 hours",
      detail: "Occurrences are converted into real bookings up to 24 hours before they happen.",
    },
    {
      icon: Repeat,
      label: "Cron cadence",
      value: "Every 15–30 minutes",
      detail: "Two-phase: generate ahead, then materialize what's due soon.",
    },
    {
      icon: Shield,
      label: "Conflict handling",
      value: "Skip-on-fail",
      detail: "If a slot is taken or a rule rejects the booking, the occurrence is marked failed with a reason. Series continues. No auto-shift today.",
    },
    {
      icon: AlertCircle,
      label: "Holiday / blackout awareness",
      value: "Via booking rules",
      detail: "The materializer respects whatever booking_rules say. There's no separate per-series skip-holidays toggle.",
    },
    {
      icon: Cog,
      label: "Max rule limits",
      value: "1000 / 365 / 5y",
      detail: "COUNT cap 1000, INTERVAL max 365, UNTIL max 5 years ahead. Rules outside these bounds are rejected.",
    },
  ];
  return (
    <section>
      <Card className="overflow-hidden p-0">
        <div className="border-b border-border/60 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink">Recurrence engine</h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                Current materialization + conflict behavior. Read-only — these
                are platform-level defaults today.
              </p>
            </div>
          </div>
        </div>
        <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3"
            >
              <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-muted text-ink-subtle">
                <r.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                  {r.label}
                </div>
                <div className="mt-0.5 text-sm font-semibold text-ink">{r.value}</div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{r.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}

// ─── Filters (Phase 12) ───────────────────────────────────────────────

function FiltersBar({
  filter,
  setFilter,
  services,
  staff,
  serviceFilter,
  setServiceFilter,
  staffFilter,
  setStaffFilter,
  cadenceFilter,
  setCadenceFilter,
  search,
  setSearch,
  counts,
}: {
  filter: StatusFilter;
  setFilter: (s: StatusFilter) => void;
  services: Service[];
  staff: Staff[];
  serviceFilter: string;
  setServiceFilter: (s: string) => void;
  staffFilter: string;
  setStaffFilter: (s: string) => void;
  cadenceFilter: "all" | "DAILY" | "WEEKLY" | "MONTHLY";
  setCadenceFilter: (s: "all" | "DAILY" | "WEEKLY" | "MONTHLY") => void;
  search: string;
  setSearch: (s: string) => void;
  counts: Metrics["counts"];
}) {
  const filters: Array<{ key: StatusFilter; label: string; count: number; tone?: "emerald" | "amber" | "rose" | "muted" }> = [
    { key: "all", label: "All", count: counts.all },
    { key: "active", label: "Active", count: counts.active, tone: "emerald" },
    { key: "paused", label: "Paused", count: counts.paused, tone: "amber" },
    { key: "cancelled", label: "Cancelled", count: counts.cancelled, tone: "rose" },
    { key: "completed", label: "Completed", count: counts.completed, tone: "muted" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {filters.map((f) => (
          <FilterChip
            key={f.key}
            label={f.label}
            count={f.count}
            active={filter === f.key}
            tone={f.tone}
            onClick={() => setFilter(f.key)}
            hideIfZero={f.key !== "all" && f.key !== "active" && f.count === 0}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
          <input
            type="text"
            placeholder="Search customer or service…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-56 rounded-lg border border-border bg-surface py-1.5 pl-8 pr-3 text-xs text-ink focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
            aria-label="Search recurring series"
          />
        </div>
        {services.length > 1 && (
          <select
            value={serviceFilter}
            onChange={(e) => setServiceFilter(e.target.value)}
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-ink focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
            aria-label="Filter by service"
          >
            <option value="all">All services</option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
        {staff.length > 1 && (
          <select
            value={staffFilter}
            onChange={(e) => setStaffFilter(e.target.value)}
            className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-ink focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
            aria-label="Filter by staff"
          >
            <option value="all">All staff</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
        <select
          value={cadenceFilter}
          onChange={(e) => setCadenceFilter(e.target.value as typeof cadenceFilter)}
          className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-ink focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
          aria-label="Filter by cadence"
        >
          <option value="all">All cadences</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
        </select>
      </div>
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  tone,
  onClick,
  hideIfZero,
}: {
  label: string;
  count: number;
  active: boolean;
  tone?: "emerald" | "amber" | "rose" | "muted";
  onClick: () => void;
  hideIfZero?: boolean;
}) {
  if (hideIfZero && count === 0) return null;
  const baseTone =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-800"
        : tone === "rose"
          ? "text-rose-700"
          : "text-ink-muted";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors duration-150 " +
        (active
          ? "border-brand-accent bg-brand-accent text-white"
          : "border-border bg-surface hover:bg-surface-muted " + baseTone)
      }
    >
      <span>{label}</span>
      <span
        className={
          "rounded-full px-1.5 text-[10px] tabular-nums " +
          (active ? "bg-white/20" : "bg-slate-100 text-slate-600")
        }
      >
        {count}
      </span>
    </button>
  );
}

// ─── Series list section ─────────────────────────────────────────────

function SeriesListSection({
  series,
  totalSeries,
  loading,
  openSeriesId,
  setOpenSeriesId,
  onAction,
  onRefresh,
  onCreate,
  actionsDisabled,
}: {
  series: Series[];
  totalSeries: number;
  loading: boolean;
  openSeriesId: string | null;
  setOpenSeriesId: (id: string | null) => void;
  onAction: (id: string, action: "pause" | "resume" | "cancel") => void;
  onRefresh: () => void;
  onCreate: () => void;
  actionsDisabled?: boolean;
}) {
  return (
    <section className="space-y-3">
      <SectionHeader
        icon={CalendarClock}
        title="Recurring series"
        subtitle={
          totalSeries === 0
            ? "No series yet."
            : `${series.length} of ${totalSeries} matching the current filters`
        }
      />
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : totalSeries === 0 ? (
        // EmptyState is unreachable when actionsDisabled — the root
        // component routes to LockedRecurringPage before this branch.
        // Kept as a safe fallback in case actionsDisabled is false.
        <EmptyState onCreate={onCreate} />
      ) : series.length === 0 ? (
        <Card className="p-6 text-center text-sm text-ink-muted">
          No series match these filters.
        </Card>
      ) : (
        <ul className="space-y-2">
          {series.map((s) => (
            <SeriesCard
              key={s.id}
              series={s}
              expanded={openSeriesId === s.id}
              onToggle={() => setOpenSeriesId(openSeriesId === s.id ? null : s.id)}
              onAction={onAction}
              onRefresh={onRefresh}
              actionsDisabled={actionsDisabled}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  const examples = [
    "Weekly payroll meetings",
    "Monthly tax planning",
    "Therapy sessions",
    "Coaching retainers",
    "Team standups",
  ];
  return (
    <Card className="overflow-hidden p-0">
      <div className="bg-gradient-to-br from-brand-accent/[0.04] to-surface p-8 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-accent/10 text-brand-accent">
          <Repeat className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-ink">
          No recurring series yet
        </h3>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-ink-muted">
          Recurring scheduling helps automate weekly, monthly, and subscription-based
          appointments. Each occurrence becomes a real booking on the calendar — same
          validation, same notifications, same routing as any direct booking.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
          {examples.map((ex) => (
            <span
              key={ex}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] text-ink-muted"
            >
              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
              {ex}
            </span>
          ))}
        </div>
        <div className="mt-6">
          <Button onClick={onCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Create recurring series
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SeriesCard({
  series,
  expanded,
  onToggle,
  onAction,
  onRefresh,
  actionsDisabled,
}: {
  series: Series;
  expanded: boolean;
  onToggle: () => void;
  onAction: (id: string, action: "pause" | "resume" | "cancel") => void;
  onRefresh: () => void;
  actionsDisabled?: boolean;
}) {
  const statusMeta = SERIES_STATUS_META[series.status] ?? SERIES_STATUS_META.completed;
  const humanized = humanizeRule(series.recurrenceRule, series.startLocal, series.endDate, series.occurrenceCount);
  const initials = (series.customerName || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("") || "?";

  return (
    <li>
      <Card className="overflow-hidden p-0 transition-shadow duration-150 hover:shadow-md">
        <div className="flex items-start gap-3 p-4">
          <CustomerAvatar name={series.customerName} initials={initials} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">
                {series.serviceName ?? series.serviceId.slice(0, 8)}
              </span>
              <span className="text-xs text-ink-muted">·</span>
              <span className="text-sm text-ink">{series.customerName}</span>
              <span
                className={
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " +
                  statusMeta.classes
                }
              >
                <span className={"h-1.5 w-1.5 rounded-full " + statusMeta.dot} />
                {statusMeta.label}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-subtle">
              <a
                href={`mailto:${series.customerEmail}`}
                className="hover:text-ink hover:underline"
              >
                {series.customerEmail}
              </a>
              {series.staffName && (
                <span>
                  · with <span className="font-medium text-ink-muted">{series.staffName}</span>
                </span>
              )}
              <span>· {series.timezone}</span>
            </div>
            <div className="mt-2 inline-flex items-start gap-1.5 rounded-md bg-surface-muted/60 px-2 py-1 text-[11px] text-ink-muted">
              <CalendarRange className="mt-0.5 h-3 w-3 shrink-0 text-ink-subtle" />
              <span>{humanized}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-ink-subtle">
              <span className="font-mono">{series.recurrenceRule}</span>
              <span>·</span>
              <span>Last generated index {series.lastMaterializedIndex}</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <div className="flex gap-1.5">
              {/* All three mutation buttons are HIDDEN (not just
                  disabled) when the capability is locked — keeps the
                  grandfathered series visible read-only without
                  tempting the operator with affordances that 402. */}
              {!actionsDisabled && series.status === "active" && (
                <button
                  onClick={() => onAction(series.id, "pause")}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] text-ink-muted hover:bg-surface-muted hover:text-ink"
                  aria-label="Pause series"
                >
                  <PauseCircle className="h-3 w-3" /> Pause
                </button>
              )}
              {!actionsDisabled && series.status === "paused" && (
                <button
                  onClick={() => onAction(series.id, "resume")}
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
                  aria-label="Resume series"
                >
                  <Play className="h-3 w-3" /> Resume
                </button>
              )}
              {!actionsDisabled && (series.status === "active" || series.status === "paused") && (
                <button
                  onClick={() => onAction(series.id, "cancel")}
                  className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-surface px-2.5 py-1 text-[11px] text-rose-700 hover:bg-rose-50"
                  aria-label="Cancel series"
                >
                  <Trash2 className="h-3 w-3" /> Cancel
                </button>
              )}
              {actionsDisabled && (
                <span
                  className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
                  title="Grandfathered — upgrade to manage this series"
                >
                  <Lock className="h-3 w-3" /> Grandfathered
                </span>
              )}
            </div>
            <button
              onClick={onToggle}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-muted hover:text-ink"
              aria-expanded={expanded}
            >
              {expanded ? (
                <>
                  <ChevronDown className="h-3 w-3" /> Hide occurrences
                </>
              ) : (
                <>
                  <ChevronRight className="h-3 w-3" /> Show occurrences
                </>
              )}
            </button>
          </div>
        </div>
        {expanded && (
          <div className="border-t border-border/60 bg-surface-muted/30 p-4">
            <OccurrencesPanel
              seriesId={series.id}
              onChanged={onRefresh}
              actionsDisabled={actionsDisabled}
            />
          </div>
        )}
      </Card>
    </li>
  );
}

function CustomerAvatar({ name, initials }: { name: string; initials: string }) {
  const palette = [
    "bg-sky-100 text-sky-700",
    "bg-violet-100 text-violet-700",
    "bg-emerald-100 text-emerald-700",
    "bg-amber-100 text-amber-700",
    "bg-rose-100 text-rose-700",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const swatch = palette[Math.abs(h) % palette.length];
  return (
    <div
      className={"grid h-10 w-10 shrink-0 place-items-center rounded-full text-[12px] font-semibold " + swatch}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

// ─── Occurrences panel ───────────────────────────────────────────────

function OccurrencesPanel({
  seriesId,
  onChanged,
  actionsDisabled,
}: {
  seriesId: string;
  onChanged: () => void;
  actionsDisabled?: boolean;
}) {
  const [occs, setOccs] = React.useState<Occurrence[] | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/tenant/booking-series/${seriesId}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setOccs(d.occurrences);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    }
  }, [seriesId]);

  React.useEffect(() => { load(); }, [load]);

  async function action(occId: string, kind: "skip" | "cancel") {
    if (
      !(await confirmAction({
        title: `${kind === "skip" ? "Skip" : "Cancel"} this occurrence?`,
        body: kind === "skip"
          ? "This single occurrence is removed from the schedule. The series continues normally."
          : "This single occurrence is cancelled. The series continues normally.",
        variant: "warning",
        confirmLabel: kind === "skip" ? "Skip occurrence" : "Cancel occurrence",
      }))
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/tenant/booking-series/${seriesId}/occurrences/${occId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: kind }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d?.error ?? `HTTP ${res.status}`);
      }
      toast("Updated", "success");
      await load();
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Action failed", "error");
    }
  }

  if (occs === null) {
    return <div className="text-xs text-ink-subtle">Loading occurrences…</div>;
  }
  if (occs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface p-4 text-center text-xs text-ink-subtle">
        No occurrences materialized yet. The cron worker generates the next 30 days.
      </div>
    );
  }
  const failedCount = occs.filter((o) => o.status === "failed").length;
  return (
    <div className="space-y-3">
      {failedCount > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-semibold">{failedCount} occurrence{failedCount === 1 ? "" : "s"} failed.</span>{" "}
            See the reason column below. The engine does not auto-retry; cancel + recreate or
            manually book if needed.
          </span>
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <table className="w-full text-xs">
          <thead className="bg-surface-muted text-left text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Booking</th>
              <th className="px-3 py-2">Detail</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {occs.map((o) => {
              const meta = OCC_STATUS_META[o.status] ?? OCC_STATUS_META.cancelled;
              const Icon = meta.icon;
              return (
                <tr key={o.id} className="border-t border-border/60">
                  <td className="px-3 py-2 tabular-nums text-ink-subtle">{o.occurrenceIndex}</td>
                  <td className="px-3 py-2 text-ink">{new Date(o.occurrenceStartAt).toLocaleString()}</td>
                  <td className="px-3 py-2">
                    <span className={"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium " + meta.classes}>
                      <Icon className="h-2.5 w-2.5" />
                      {meta.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[10px] text-ink-subtle">
                    {o.bookingId ? o.bookingId.slice(0, 8) : "—"}
                  </td>
                  <td className="px-3 py-2 text-ink-muted">
                    {o.failureReason
                      ? <span className="text-rose-700">{o.failureReason}</span>
                      : o.attempts > 0
                        ? `${o.attempts} attempts`
                        : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/* Occurrence-level actions follow the same lock
                        contract as series-level: hidden, not disabled,
                        when capability is locked. The row remains
                        visible (read-only) so the operator can SEE
                        what's been generated under their previous
                        subscription. */}
                    {!actionsDisabled && o.status === "scheduled" && !o.bookingId && (
                      <div className="inline-flex items-center gap-2">
                        <button
                          onClick={() => action(o.id, "skip")}
                          className="text-[11px] text-ink-muted hover:text-ink"
                        >
                          Skip
                        </button>
                        <button
                          onClick={() => action(o.id, "cancel")}
                          className="text-[11px] text-rose-600 hover:text-rose-700"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Create series card (Phases 5, 6, 8) ─────────────────────────────

function CreateSeriesCard({
  services,
  staff,
  onClose,
  onCreated,
}: {
  services: Service[];
  staff: Staff[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [serviceId, setServiceId] = React.useState<string>("");
  const [staffUserId, setStaffUserId] = React.useState<string>("");
  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");
  const [freq, setFreq] = React.useState<"DAILY" | "WEEKLY" | "MONTHLY">("WEEKLY");
  const [interval, setInterval] = React.useState("1");
  const [byday, setByday] = React.useState<Record<string, boolean>>({});
  const [until, setUntil] = React.useState("");
  const [countLimit, setCountLimit] = React.useState("");
  const [startDate, setStartDate] = React.useState("");
  const [startTime, setStartTime] = React.useState("09:00");
  const [timezone, setTimezone] = React.useState(staff[0]?.timezone ?? "UTC");
  const [submitting, setSubmitting] = React.useState(false);

  const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

  function ruleString(): string {
    const parts = [`FREQ=${freq}`];
    if (Number(interval) > 1) parts.push(`INTERVAL=${interval}`);
    if (freq === "WEEKLY") {
      const days = Object.entries(byday).filter(([, v]) => v).map(([k]) => k);
      if (days.length > 0) parts.push(`BYDAY=${days.join(",")}`);
    }
    if (until) parts.push(`UNTIL=${until.replace(/-/g, "")}`);
    if (countLimit) parts.push(`COUNT=${countLimit}`);
    return parts.join(";");
  }

  // Live human-readable summary
  const humanized = React.useMemo(() => {
    if (!startDate) return "Pick a start date to preview";
    const rule = ruleString();
    return humanizeRule(rule, `${startDate}T${startTime}:00`, until || null, countLimit ? Number(countLimit) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, interval, byday, until, countLimit, startDate, startTime]);

  // Phase 8 — live next-5 occurrences preview (client-side expand)
  const previewDates = React.useMemo(() => {
    if (!startDate) return [] as Date[];
    try {
      return previewOccurrences({
        freq,
        interval: Number(interval) || 1,
        byday: Object.entries(byday).filter(([, v]) => v).map(([k]) => k),
        startLocal: `${startDate}T${startTime}:00`,
        until: until || null,
        count: countLimit ? Number(countLimit) : null,
        max: 5,
      });
    } catch {
      return [];
    }
  }, [freq, interval, byday, until, countLimit, startDate, startTime]);

  async function submit() {
    if (!serviceId || !staffUserId || !customerName || !customerEmail || !startDate) {
      toast("Fill all required fields", "error");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/tenant/booking-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          staffUserId,
          customerName,
          customerEmail,
          recurrenceRule: ruleString(),
          startLocal: `${startDate}T${startTime}:00`,
          timezone,
          occurrenceCount: countLimit ? Number(countLimit) : null,
          endDate: until || null,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Create failed");
      toast("Series created. The worker will materialize occurrences shortly.", "success");
      onCreated();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Create failed", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
            <Plus className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold text-ink">New recurring series</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-ink-muted hover:bg-surface-muted hover:text-ink"
          aria-label="Close form"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-5 p-5 lg:grid-cols-[1fr_320px]">
        {/* Left: form */}
        <div className="space-y-5">
          <FormGroup label="Who & what" icon={Users}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Service">
                <select
                  value={serviceId}
                  onChange={(e) => setServiceId(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                  aria-label="Service"
                >
                  <option value="">— pick a service —</option>
                  {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Staff">
                <select
                  value={staffUserId}
                  onChange={(e) => {
                    setStaffUserId(e.target.value);
                    const s = staff.find((x) => x.id === e.target.value);
                    if (s) setTimezone(s.timezone);
                  }}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                  aria-label="Staff"
                >
                  <option value="">— pick staff —</option>
                  {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Field>
              <Field label="Customer name">
                <input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Jane Doe"
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                />
              </Field>
              <Field label="Customer email">
                <input
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  placeholder="jane@example.com"
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                />
              </Field>
            </div>
          </FormGroup>

          <FormGroup label="When it starts" icon={CalendarClock}>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="First date">
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                />
              </Field>
              <Field label="Time (local)">
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm tabular-nums focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                />
              </Field>
              <Field label="Timezone" helper="Inherits from staff. Override if needed.">
                <input
                  type="text"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                />
              </Field>
            </div>
          </FormGroup>

          <FormGroup label="Recurrence" icon={Repeat}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-muted">Repeat every</span>
              <input
                type="number"
                min={1}
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
                className="w-16 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm tabular-nums focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                aria-label="Recurrence interval"
              />
              <select
                value={freq}
                onChange={(e) => setFreq(e.target.value as typeof freq)}
                className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                aria-label="Recurrence frequency"
              >
                <option value="DAILY">day(s)</option>
                <option value="WEEKLY">week(s)</option>
                <option value="MONTHLY">month(s)</option>
              </select>
            </div>
            {freq === "WEEKLY" && (
              <div className="mt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                  On these days
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((d) => {
                    const on = Boolean(byday[d]);
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setByday((cur) => ({ ...cur, [d]: !cur[d] }))}
                        aria-pressed={on}
                        className={
                          "rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-150 " +
                          (on
                            ? "border-brand-accent bg-brand-accent text-white"
                            : "border-border bg-surface text-ink-muted hover:bg-surface-muted")
                        }
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="End date (optional)">
                <input
                  type="date"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                />
              </Field>
              <Field label="Or after N occurrences">
                <input
                  type="number"
                  min={1}
                  value={countLimit}
                  onChange={(e) => setCountLimit(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm tabular-nums focus:border-brand-accent focus:outline-none focus:ring-2 focus:ring-brand-accent/20"
                />
              </Field>
            </div>
            <p className="mt-2 text-[11px] text-ink-subtle">
              End date and occurrence count are mutually exclusive. Set neither for a series with no fixed end.
            </p>
          </FormGroup>
        </div>

        {/* Right: live preview (Phase 5, 6, 8) */}
        <div className="space-y-3">
          <div className="rounded-xl border border-border bg-surface-muted/40 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
              Natural-language summary
            </div>
            <p className="mt-1 text-sm font-medium text-ink">{humanized}</p>
            <div className="mt-3 border-t border-border/60 pt-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                Rule
              </div>
              <code className="mt-1 block font-mono text-[11px] text-ink-muted">
                {ruleString()}
              </code>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
                Next occurrences preview
              </div>
              <span className="text-[10px] text-ink-subtle">first 5</span>
            </div>
            {previewDates.length === 0 ? (
              <p className="mt-2 text-xs text-ink-subtle">
                {startDate
                  ? "Add at least one day-of-week for weekly recurrence."
                  : "Pick a start date to preview."}
              </p>
            ) : (
              <ol className="mt-2 space-y-1.5">
                {previewDates.map((d, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface-muted/30 px-2.5 py-1.5 text-xs"
                  >
                    <span className="w-5 text-center text-[10px] font-medium text-ink-subtle">
                      {i + 1}
                    </span>
                    <span className="text-ink">
                      {d.toLocaleDateString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
                      })}
                    </span>
                    <span className="text-ink-subtle">·</span>
                    <span className="text-ink-muted tabular-nums">
                      {d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-2 text-[10px] text-ink-subtle">
              Preview is client-side; final dates are computed server-side with DST + booking
              rule validation on each occurrence.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-surface-muted/30 px-5 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md px-3 py-1.5 text-xs text-ink-muted hover:bg-surface hover:text-ink"
        >
          Cancel
        </button>
        <Button onClick={submit} disabled={submitting}>
          {submitting ? "Creating…" : (
            <span className="inline-flex items-center gap-1.5">
              <ArrowRight className="h-3.5 w-3.5" /> Create series
            </span>
          )}
        </Button>
      </div>
    </Card>
  );
}

function FormGroup({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      {children}
    </div>
  );
}

function Field({
  label,
  helper,
  children,
}: {
  label: string;
  helper?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-ink">{label}</label>
      <div className="mt-1">{children}</div>
      {helper && <p className="mt-1 text-[10px] text-ink-subtle">{helper}</p>}
    </div>
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
    <div className="flex items-start gap-3 px-1">
      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-accent/10 text-brand-accent">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
      </div>
    </div>
  );
}

// ─── Metrics ─────────────────────────────────────────────────────────

type Metrics = {
  counts: {
    all: number;
    active: number;
    paused: number;
    cancelled: number;
    completed: number;
  };
  upcomingOccurrences: number;
  bookedThisMonth: number;
  failedOccurrences: number;
};

function deriveMetrics(data: ApiData | null): Metrics {
  if (!data) {
    return {
      counts: { all: 0, active: 0, paused: 0, cancelled: 0, completed: 0 },
      upcomingOccurrences: 0,
      bookedThisMonth: 0,
      failedOccurrences: 0,
    };
  }
  const counts = {
    all: data.series.length,
    active: data.series.filter((s) => s.status === "active").length,
    paused: data.series.filter((s) => s.status === "paused").length,
    cancelled: data.series.filter((s) => s.status === "cancelled").length,
    completed: data.series.filter((s) => s.status === "completed").length,
  };
  // Phase-15-honesty: these next three are exposed in the per-series
  // occurrences endpoint, not in the list endpoint, so we don't have
  // them at list time. We render zero rather than fabricate.
  // A future phase could add a summary API to populate these.
  return {
    counts,
    upcomingOccurrences: 0,
    bookedThisMonth: 0,
    failedOccurrences: 0,
  };
}

// ─── RRULE humanizer + client-side preview ───────────────────────────

function parseFreq(rule: string): string | null {
  const m = rule.match(/FREQ=([A-Z]+)/);
  return m ? m[1] : null;
}

function humanizeRule(
  rule: string,
  startLocal: string,
  endDate: string | null,
  count: number | null,
): string {
  const freq = parseFreq(rule);
  if (!freq) return rule;
  const intervalMatch = rule.match(/INTERVAL=(\d+)/);
  const interval = intervalMatch ? Number(intervalMatch[1]) : 1;
  const bydayMatch = rule.match(/BYDAY=([A-Z,]+)/);
  const byday = bydayMatch ? bydayMatch[1].split(",") : [];
  const timeMatch = startLocal.match(/T(\d{2}):(\d{2})/);
  const timeStr = timeMatch
    ? formatTime(Number(timeMatch[1]), Number(timeMatch[2]))
    : "";

  const dayMap: Record<string, string> = {
    MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun",
  };

  let phrase = "";
  if (freq === "DAILY") {
    phrase = interval === 1 ? "Every day" : `Every ${interval} days`;
  } else if (freq === "WEEKLY") {
    const dayLabels = byday.map((d) => dayMap[d] ?? d);
    const base = interval === 1 ? "Every week" : interval === 2 ? "Every other week" : `Every ${interval} weeks`;
    if (dayLabels.length > 0) {
      phrase = `${base} on ${dayLabels.join(", ")}`;
    } else {
      phrase = base;
    }
  } else if (freq === "MONTHLY") {
    phrase = interval === 1 ? "Every month" : `Every ${interval} months`;
  } else {
    phrase = `Custom rule (${freq})`;
  }
  if (timeStr) phrase += ` at ${timeStr}`;
  if (count) {
    phrase += ` · ${count} occurrence${count === 1 ? "" : "s"}`;
  } else if (endDate) {
    phrase += ` · until ${formatDateShort(endDate)}`;
  } else {
    phrase += " · no end date";
  }
  return phrase;
}

function formatTime(h: number, m: number): string {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function formatDateShort(yyyymmdd: string): string {
  try {
    const d = new Date(yyyymmdd + "T12:00:00Z");
    if (Number.isNaN(d.getTime())) return yyyymmdd;
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });
  } catch {
    return yyyymmdd;
  }
}

/**
 * Client-side occurrence preview. Mirrors the SERVER engine's basic
 * iteration: DAILY/WEEKLY/MONTHLY with INTERVAL + BYDAY + UNTIL + COUNT.
 * Does NOT replace the server engine — that one handles DST + timezone
 * via Intl + booking-rule validation. This is purely a preview helper
 * so the admin sees what they're about to create.
 */
function previewOccurrences(args: {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byday: string[];
  startLocal: string;
  until: string | null;
  count: number | null;
  max: number;
}): Date[] {
  const out: Date[] = [];
  const startMatch = args.startLocal.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!startMatch) return out;
  const [, y, mo, d, hh, mm] = startMatch;
  const start = new Date(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), 0);
  const untilDate = args.until ? new Date(args.until + "T23:59:59") : null;
  const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const targetDays = args.byday.map((d) => dayMap[d]).filter((n) => n !== undefined);

  const limit = args.count ? Math.min(args.max, args.count) : args.max;
  let cursor = new Date(start);
  let safety = 0;

  while (out.length < limit && safety < 1000) {
    safety += 1;
    if (untilDate && cursor > untilDate) break;
    if (args.freq === "WEEKLY" && targetDays.length > 0) {
      if (targetDays.includes(cursor.getDay())) {
        out.push(new Date(cursor));
      }
      cursor = addDays(cursor, 1);
      // After completing a week, advance by (interval - 1) extra weeks.
      if (cursor.getDay() === start.getDay() && args.interval > 1 && out.length > 0) {
        cursor = addDays(cursor, 7 * (args.interval - 1));
      }
    } else {
      // First occurrence is the start date.
      if (out.length === 0 || satisfiesInterval(out[out.length - 1], cursor, args.freq, args.interval)) {
        out.push(new Date(cursor));
      }
      if (args.freq === "DAILY") {
        cursor = addDays(cursor, args.interval);
      } else if (args.freq === "WEEKLY") {
        cursor = addDays(cursor, 7 * args.interval);
      } else if (args.freq === "MONTHLY") {
        cursor = addMonths(cursor, args.interval);
      }
    }
  }
  return out;
}

function satisfiesInterval(_prev: Date, _next: Date, _freq: string, _interval: number): boolean {
  // Tracking is handled by cursor advancement above; this is a no-op
  // guard kept for clarity / future complexity.
  return true;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + n);
  return out;
}

// ─── Free-plan locked surfaces (Phase 6 — UI lockdown) ──────────────
//
// Two components render when the recurring_series capability is locked:
//
//   GrandfatherBanner — for tenants WITH existing series (read-only mode).
//     Inline strip at the top of the page that explains why action
//     buttons are missing + offers upgrade.
//
//   LockedRecurringPage — for tenants WITHOUT any series (full lock).
//     Premium upgrade hero replacing the operational dashboard.

function GrandfatherBanner({
  cap,
  count,
}: {
  cap: { reason: string };
  count: number;
}) {
  return (
    <div className="rounded-xl border border-amber-200/70 bg-gradient-to-r from-amber-50 via-surface to-surface p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            {count} recurring{" "}
            {count === 1 ? "series is" : "series are"} grandfathered from your
            previous subscription
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
            Your existing {count === 1 ? "series continues" : "series continue"}{" "}
            to materialize bookings automatically. Upgrade to Pro to create new
            series, edit existing ones, or pause / resume execution.
          </p>
          <div className="mt-2 text-[11px] text-ink-subtle">{cap.reason}</div>
        </div>
        <Link
          href="/dashboard/billing"
          className="shrink-0 rounded-md bg-brand-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm hover:bg-brand-accent/90"
        >
          See plans
        </Link>
      </div>
    </div>
  );
}

function LockedRecurringPage({ cap }: { cap: { reason: string } }) {
  // Premium locked experience — fills the canvas with feature
  // visualization + outcomes + use cases + Free-vs-Pro comparison.
  // No business/capability logic here; that's all in the parent
  // (cap.allowed check before this component mounts).
  void cap; // reason is read from the provider inside the primitive
  return (
    <PremiumLockedExperience
      cap="recurring_series"
      eyebrow="Subscription scheduling"
      title="Recurring scheduling, fully automated"
      tagline="Set the cadence once. The engine handles every occurrence — bookings, reminders, calendar sync, routing — without lifting a finger."
      description="Each occurrence becomes a real booking that flows through the same validation, routing, and notifications as a direct booking. Cancel a single occurrence, pause the series, or let it run forever — your call."
      primaryCta={{ label: "Unlock recurring scheduling", href: "/dashboard/billing" }}
      secondaryCta={{ label: "Compare plans", href: "/pricing" }}
      visualization={<RecurringSchedulingPreview />}
      outcomes={[
        {
          icon: Zap,
          title: "Reduce manual scheduling overhead",
          body: "Stop rebooking the same customer every week. Set it once and the engine materializes occurrences ahead of time.",
        },
        {
          icon: TrendingUp,
          title: "Predictable revenue, automated",
          body: "Subscription-style appointments lift retention and create a steady operational rhythm your team can plan around.",
        },
        {
          icon: Heart,
          title: "Better customer experience",
          body: "Customers know exactly when their next appointment is — no back-and-forth, no missed bookings, no awkward reminders.",
        },
      ]}
      useCases={[
        "Therapy sessions",
        "Coaching retainers",
        "Monthly tax planning",
        "Weekly payroll meetings",
        "Personal training",
        "Recurring grooming",
      ]}
      comparison={{
        free: ["One-time bookings", "Public booking page", "Basic reminders", "Booking lifecycle hooks"],
        pro: [
          "Recurring scheduling (weekly / monthly / custom RRULE)",
          "Automation workflows + review campaigns",
          "Waitlists with auto-fill",
          "Advanced staff routing modes",
          "Custom branded domain",
          "Analytics + CSV export",
        ],
      }}
      faqItems={[
        {
          q: "Does each occurrence respect my booking rules?",
          a: "Yes. Every materialized occurrence runs through validateBookingRules — same notice, advance, cap, and blackout checks as a direct booking.",
        },
        {
          q: "What happens if I cancel my Pro subscription?",
          a: "Existing recurring series are grandfathered — the cron keeps materializing them. You just can't create or edit new series until you re-upgrade.",
        },
        {
          q: "Can customers reschedule individual occurrences?",
          a: "Yes. Each occurrence becomes a real booking row with its own reschedule + cancel flow, independent of the series.",
        },
        {
          q: "How are conflicts handled?",
          a: "If a slot is taken or a rule rejects the occurrence, that specific occurrence is marked failed with a reason. The series continues — no auto-shift surprises.",
        },
      ]}
    />
  );
}
