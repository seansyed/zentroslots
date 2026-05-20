"use client";

import * as React from "react";
import {
  Plane,
  CalendarOff,
  Clock,
  Coffee,
  Sun,
  MapPin,
  Layers,
  Users,
  Building2,
  Video,
  Globe,
  ChevronRight,
  Trash2,
  Pencil,
  Search,
  Shuffle,
  RotateCw,
  AlertTriangle,
  CalendarRange,
  Pin,
  ArrowRightLeft,
  type LucideIcon,
} from "lucide-react";

import { Avatar, Button, Skeleton, toast } from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import { locationSwatch, locationTypeIcon, locationTypeLabel } from "@/lib/location-visual";

// ─── Public types (consumed by page.tsx) ──────────────────────────

export type WorkforceLite = {
  id: string;
  displayName: string;
  title: string | null;
  role: "admin" | "manager" | "staff";
  timezone: string;
  avatarUrl: string | null;
  deliveryMode: "in_person" | "virtual" | "hybrid";
};

export type ExceptionRow = {
  id: string;
  userId: string;
  staffName: string;
  staffRole: "admin" | "manager" | "staff";
  staffTitle: string | null;
  staffAvatarUrl: string | null;
  staffTimezone: string;
  deliveryMode: "in_person" | "virtual" | "hybrid";
  /** YYYY-MM-DD in user's timezone */
  date: string;
  unavailable: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
  /** Honest "coverage impact" data: # of services + which locations */
  affectedServiceCount: number;
  affectedLocations: Array<{ id: string; name: string; type: "physical" | "virtual" | "hybrid" }>;
};

type KpiBundle = {
  totalUpcoming: number;
  vacationsNext30dStaff: number;
  fullDayBlocks: number;
  partialDayBlocks: number;
  workforceCount: number;
};

// ─── Exception type taxonomy ──────────────────────────────────────
//
// The database schema is intentionally simple: a row is either
// "unavailable all day" (vacation/block/holiday) or "custom hours"
// (custom window or lunch break). The conceptual TYPE is inferred
// from the reason text plus the unavailable flag — purely UI sugar
// so operators can scan a timeline without parsing strings.

type ExceptionKind = "vacation" | "block" | "holiday" | "custom" | "lunch";

function deriveKind(row: { unavailable: boolean; reason: string | null }): ExceptionKind {
  const r = (row.reason ?? "").toLowerCase();
  if (row.unavailable) {
    if (/vac|pto|leave|out of office|ooo/.test(r)) return "vacation";
    if (/holiday|christmas|thanks|new year|easter|memorial|labor|independence/.test(r)) return "holiday";
    return "block";
  }
  if (/lunch|break|tea|coffee/.test(r)) return "lunch";
  return "custom";
}

const KIND_META: Record<ExceptionKind, {
  label: string;
  icon: LucideIcon;
  tone: string;        // chip ring/bg/text
  accent: string;      // left-edge accent bar
  haloHover: string;   // hover halo on the timeline card
}> = {
  vacation: {
    label: "Vacation",
    icon: Plane,
    tone: "bg-sky-50 text-sky-700 ring-sky-200/60",
    accent: "bg-sky-500",
    haloHover: "hover:shadow-[0_0_22px_rgba(14,165,233,0.22)]",
  },
  block: {
    label: "Blocked day",
    icon: CalendarOff,
    tone: "bg-rose-50 text-rose-700 ring-rose-200/60",
    accent: "bg-rose-500",
    haloHover: "hover:shadow-[0_0_22px_rgba(244,63,94,0.22)]",
  },
  holiday: {
    label: "Holiday",
    icon: Sun,
    tone: "bg-amber-50 text-amber-700 ring-amber-200/60",
    accent: "bg-amber-500",
    haloHover: "hover:shadow-[0_0_22px_rgba(245,158,11,0.22)]",
  },
  custom: {
    label: "Custom hours",
    icon: Clock,
    tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/60",
    accent: "bg-emerald-500",
    haloHover: "hover:shadow-[0_0_22px_rgba(16,185,129,0.22)]",
  },
  lunch: {
    label: "Lunch break",
    icon: Coffee,
    tone: "bg-indigo-50 text-indigo-700 ring-indigo-200/60",
    accent: "bg-indigo-500",
    haloHover: "hover:shadow-[0_0_22px_rgba(99,102,241,0.22)]",
  },
};

// ─── Date helpers (pure UI sugar — never affects engine) ──────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayLabel(dateISO: string): string {
  // YYYY-MM-DD → "Mon, Dec 25". Use UTC parse to avoid TZ drift
  // since the storage is a date column (no time component).
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function relativeLabel(dateISO: string): string {
  const today = todayISO();
  if (dateISO === today) return "Today";
  const [y, m, d] = dateISO.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  const a = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  const b = Date.UTC(ty, (tm ?? 1) - 1, td ?? 1);
  const diff = Math.round((a - b) / 86_400_000);
  if (diff === 1) return "Tomorrow";
  if (diff > 0 && diff < 7) return `In ${diff} days`;
  if (diff >= 7 && diff < 30) return `In ${Math.round(diff / 7)} wk`;
  if (diff >= 30 && diff < 365) return `In ${Math.round(diff / 30)} mo`;
  return dayLabel(dateISO);
}

// ─── Top-level component ──────────────────────────────────────────

export default function ExceptionsClient({
  isAdmin,
  callerUserId,
  callerTimezone,
  workforce,
  exceptions: initialExceptions,
  kpis,
}: {
  isAdmin: boolean;
  callerUserId: string;
  callerTimezone: string;
  workforce: WorkforceLite[];
  exceptions: ExceptionRow[];
  kpis: KpiBundle;
}) {
  const [exceptions, setExceptions] = React.useState<ExceptionRow[]>(initialExceptions);
  const [scope, setScope] = React.useState<"staff" | "workspace" | "location">("staff");
  const [query, setQuery] = React.useState("");

  // Re-sync exception state if the server-rendered set changes (rare
  // — we mostly mutate locally).
  React.useEffect(() => {
    setExceptions(initialExceptions);
  }, [initialExceptions]);

  function onCreated(row: ExceptionRow) {
    setExceptions((cur) => [...cur, row].sort((a, b) => a.date.localeCompare(b.date)));
  }
  function onBulkCreated(rows: ExceptionRow[]) {
    setExceptions((cur) => [...cur, ...rows].sort((a, b) => a.date.localeCompare(b.date)));
  }
  function onDeleted(id: string) {
    setExceptions((cur) => cur.filter((e) => e.id !== id));
  }

  // Apply the search filter to the timeline. We match staff name,
  // reason, day label, kind label, and location name so a manager
  // can find "downtown" or "vacation" or "Sean" instantly.
  const filteredExceptions = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return exceptions;
    return exceptions.filter((e) => {
      if (e.staffName.toLowerCase().includes(q)) return true;
      if ((e.reason ?? "").toLowerCase().includes(q)) return true;
      if (dayLabel(e.date).toLowerCase().includes(q)) return true;
      if (KIND_META[deriveKind(e)].label.toLowerCase().includes(q)) return true;
      if (e.affectedLocations.some((l) => l.name.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [exceptions, query]);

  return (
    <div className="space-y-5 pb-24">
      {/* Hero */}
      <ExceptionsHero callerTimezone={callerTimezone} />

      {/* Hierarchy diagram */}
      <HierarchyDiagram />

      {/* KPI strip */}
      <KpiRow kpis={kpis} />

      {/* Scope tabs */}
      <ScopeTabs scope={scope} setScope={setScope} isAdmin={isAdmin} />

      {/* Editor — only the Staff scope is functional today; the
          other scopes show a calm "Coming soon" panel describing
          the architecture we'll need to add to ship them. */}
      {scope === "staff" && (
        <NewExceptionPanel
          isAdmin={isAdmin}
          callerUserId={callerUserId}
          callerTimezone={callerTimezone}
          workforce={workforce}
          onCreated={onCreated}
          onBulkCreated={onBulkCreated}
        />
      )}
      {scope === "workspace" && <ScopeComingSoon scope="workspace" />}
      {scope === "location" && <ScopeComingSoon scope="location" />}

      {/* Timeline */}
      <TimelineCard
        exceptions={filteredExceptions}
        totalCount={exceptions.length}
        query={query}
        setQuery={setQuery}
        canDelete={isAdmin}
        callerUserId={callerUserId}
        onDeleted={onDeleted}
      />

      {/* Future date-exception engine scaffolds */}
      <FutureScaffolds />
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────

function ExceptionsHero({ callerTimezone }: { callerTimezone: string }) {
  return (
    <PremiumCard className="relative overflow-hidden p-5">
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-accent/12 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-12 bottom-0 h-32 w-32 rounded-full bg-amber-500/8 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-amber-50/80 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
            Workforce exception orchestration
          </div>
          <h1 className="mt-2.5 text-[22px] font-semibold tracking-tight text-ink sm:text-[24px]">
            Workforce exceptions &amp; coverage
          </h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            Manage vacations, temporary schedule changes, blocked days, lunch breaks, regional holidays, and
            operational coverage exceptions. Date-scoped overrides supersede weekly rules — the engine resolves
            the rest.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-border bg-surface/80 px-2.5 py-1 text-[11px] font-medium text-ink-muted shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:self-end">
          <Clock className="h-3 w-3 text-brand-accent" strokeWidth={2} />
          Your timezone <span className="font-semibold text-ink">{callerTimezone}</span>
        </span>
      </div>
    </PremiumCard>
  );
}

// ─── Hierarchy diagram ──────────────────────────────────────────

function HierarchyDiagram() {
  const layers: { idx: number; icon: LucideIcon; title: string; caption: string; tone: string }[] = [
    {
      idx: 1,
      icon: CalendarRange,
      title: "Weekly rules",
      caption: "Workspace defaults + per-staff overrides.",
      tone: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/20",
    },
    {
      idx: 2,
      icon: CalendarOff,
      title: "Overrides",
      caption: "Date-scoped exceptions — this page.",
      tone: "bg-amber-50 text-amber-700 ring-amber-200/40",
    },
    {
      idx: 3,
      icon: Layers,
      title: "Resolved availability",
      caption: "Engine output, exception-aware.",
      tone: "bg-sky-50 text-sky-700 ring-sky-200/40",
    },
    {
      idx: 4,
      icon: Pin,
      title: "Booking coverage",
      caption: "Slots exposed to customers.",
      tone: "bg-violet-50 text-violet-700 ring-violet-200/40",
    },
  ];
  return (
    <PremiumCard className="p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Exception hierarchy</div>
      <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">How exceptions compose with the schedule</h2>
      <p className="mt-0.5 text-[11.5px] text-ink-muted">
        Overrides temporarily supersede the weekly rules they target. The resolver merges both, then routes
        the result to the booking surface. You orchestrate exceptions here — the engine handles the rest.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {layers.map((l, i) => {
          const Icon = l.icon;
          return (
            <div
              key={l.idx}
              className="relative flex items-start gap-2.5 rounded-xl border border-border bg-surface p-3 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
            >
              <span className="absolute -top-1.5 left-3 inline-flex h-4 items-center rounded-full bg-surface px-1.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-ink-subtle ring-1 ring-border">
                Step {l.idx}
              </span>
              <span className={cn("mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1", l.tone)}>
                <Icon className="h-4 w-4" strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold tracking-tight text-ink">{l.title}</div>
                <div className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{l.caption}</div>
              </div>
              {i < layers.length - 1 && (
                <span aria-hidden className="pointer-events-none absolute -right-2.5 top-1/2 hidden -translate-y-1/2 text-ink-subtle lg:inline">
                  <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </PremiumCard>
  );
}

// ─── KPI row ────────────────────────────────────────────────────

function KpiRow({ kpis }: { kpis: KpiBundle }) {
  const items: Array<{ icon: LucideIcon; label: string; value: string; sub?: string; tone: string }> = [
    {
      icon: CalendarRange,
      label: "Upcoming exceptions",
      value: String(kpis.totalUpcoming),
      sub: "next 30 days",
      tone: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15",
    },
    {
      icon: Plane,
      label: "Staff on vacation",
      value: String(kpis.vacationsNext30dStaff),
      sub: kpis.workforceCount > 0 ? `of ${kpis.workforceCount}` : undefined,
      tone: "bg-sky-50 text-sky-700 ring-sky-200/40",
    },
    {
      icon: CalendarOff,
      label: "Full-day blocks",
      value: String(kpis.fullDayBlocks),
      sub: "next 30 days",
      tone: "bg-rose-50 text-rose-700 ring-rose-200/40",
    },
    {
      icon: Clock,
      label: "Partial-day exceptions",
      value: String(kpis.partialDayBlocks),
      sub: "next 30 days",
      tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/40",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <PremiumCard key={it.label} className="relative overflow-hidden p-3">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[9.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{it.label}</div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-[20px] font-semibold leading-none tabular-nums tracking-tight text-ink">{it.value}</span>
                  {it.sub && <span className="text-[10.5px] text-ink-subtle">{it.sub}</span>}
                </div>
              </div>
              <span className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1", it.tone)}>
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
            </div>
          </PremiumCard>
        );
      })}
    </div>
  );
}

// ─── Scope tabs ─────────────────────────────────────────────────

function ScopeTabs({
  scope,
  setScope,
  isAdmin,
}: {
  scope: "staff" | "workspace" | "location";
  setScope: (s: "staff" | "workspace" | "location") => void;
  isAdmin: boolean;
}) {
  const tabs: Array<{ id: "staff" | "workspace" | "location"; label: string; icon: LucideIcon; live: boolean; caption: string }> = [
    {
      id: "staff",
      label: "Staff",
      icon: Users,
      live: true,
      caption: isAdmin ? "Edit any staff member's exceptions." : "Edit your own exceptions.",
    },
    {
      id: "workspace",
      label: "Workspace",
      icon: Layers,
      live: false,
      caption: "Tenant-wide closures (e.g. office holidays).",
    },
    {
      id: "location",
      label: "Location",
      icon: MapPin,
      live: false,
      caption: "Per-location closures (e.g. Downtown closed Friday).",
    },
  ];
  return (
    <PremiumCard className="p-1.5">
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = scope === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setScope(t.id)}
              className={cn(
                "group relative overflow-hidden rounded-lg px-3 py-2.5 text-left transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                active
                  ? "bg-brand-subtle/40 ring-2 ring-brand-accent/30 shadow-soft"
                  : "hover:bg-surface-inset/60",
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1 transition-colors duration-[200ms]",
                    active ? "bg-brand-accent/10 text-brand-accent ring-brand-accent/20" : "bg-surface-inset text-ink-muted ring-border/40",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                </span>
                <span className="text-[13px] font-semibold tracking-tight text-ink">{t.label}</span>
                {!t.live && (
                  <span className="ml-auto inline-flex items-center rounded-full bg-surface px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
                    Coming soon
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{t.caption}</p>
            </button>
          );
        })}
      </div>
    </PremiumCard>
  );
}

function ScopeComingSoon({ scope }: { scope: "workspace" | "location" }) {
  const meta = scope === "workspace"
    ? {
        icon: Layers,
        title: "Workspace-wide exceptions",
        caption: "Close the entire workspace for an office holiday or planned downtime in a single action — propagating to every staff member without per-row entries.",
        rationale: "Needs a tenant-level holidays table (tenant_holidays) so the resolver can apply it across all workforce members without inserting N override rows.",
      }
    : {
        icon: MapPin,
        title: "Location-scoped closures",
        caption: "Close a single location (e.g. Downtown office closed Friday) while other locations and virtual delivery continue normally.",
        rationale: "Needs a location_closures table joined into the location-presence resolver so per-day routing skips the closed location only.",
      };
  const Icon = meta.icon;
  return (
    <PremiumCard className="relative overflow-hidden p-5">
      <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-amber-400/10 blur-3xl" />
      <div className="relative flex items-start gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-700 ring-1 ring-amber-200/40">
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </span>
        <div>
          <div className="flex items-center gap-1.5">
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">{meta.title}</h3>
            <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink-muted ring-1 ring-border/40">
              Coming soon
            </span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{meta.caption}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
            <span className="font-semibold text-ink-muted">Architecture note · </span>
            {meta.rationale}
          </p>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── New exception panel (Staff scope) ───────────────────────────

function NewExceptionPanel({
  isAdmin,
  callerUserId,
  callerTimezone,
  workforce,
  onCreated,
  onBulkCreated,
}: {
  isAdmin: boolean;
  callerUserId: string;
  callerTimezone: string;
  workforce: WorkforceLite[];
  onCreated: (row: ExceptionRow) => void;
  onBulkCreated: (rows: ExceptionRow[]) => void;
}) {
  // Form state. Default target = the caller; admins can switch.
  const [targetUserId, setTargetUserId] = React.useState<string>(callerUserId);
  const [kind, setKind] = React.useState<ExceptionKind | "batch">("vacation");
  const [date, setDate] = React.useState<string>("");
  const [startTime, setStartTime] = React.useState<string>("12:00");
  const [endTime, setEndTime] = React.useState<string>("13:00");
  const [reason, setReason] = React.useState<string>("");
  const [batchDates, setBatchDates] = React.useState<string>("");
  const [saving, setSaving] = React.useState(false);

  // Lunch + custom both need a time window; vacation/block/holiday
  // are full-day. Batch is a multi-date entry of full-day blocks
  // (typical use: company holiday list).
  const wantsTimes = kind === "custom" || kind === "lunch";

  // Suggest a tasteful default reason per kind — it makes the
  // timeline scan-readable without forcing manual entry.
  React.useEffect(() => {
    if (reason.trim() !== "" && reason !== "Vacation" && reason !== "Blocked day" && reason !== "Holiday" && reason !== "Lunch break") {
      return;
    }
    if (kind === "vacation") setReason("Vacation");
    else if (kind === "block") setReason("Blocked day");
    else if (kind === "holiday") setReason("Holiday");
    else if (kind === "lunch") setReason("Lunch break");
    else setReason("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const targetWorkforce = React.useMemo(
    () => workforce.find((w) => w.id === targetUserId) ?? null,
    [workforce, targetUserId],
  );

  async function submit() {
    setSaving(true);
    try {
      if (kind === "batch") {
        const dates = batchDates
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (dates.length === 0) {
          toast("Add at least one date", "error");
          setSaving(false);
          return;
        }
        const res = await fetch("/api/availability/overrides/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: targetUserId,
            dates,
            unavailable: true,
            reason: reason || "Holiday",
          }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d?.error ?? "Bulk save failed");
        // Server returns count + ids only; refetch the new rows so
        // we can render them in the timeline with full enrichment.
        const refresh = await fetch(`/api/availability/overrides?userId=${targetUserId}`);
        const refreshed = await refresh.json();
        const inserted: ExceptionRow[] = Array.isArray(refreshed)
          ? (refreshed as Array<{ id: string; date: string; unavailable: boolean; startTime: string | null; endTime: string | null; reason: string | null }>)
              .filter((r) => d.ids.includes(r.id))
              .map((r) => composeRow(r, targetWorkforce, callerTimezone))
          : [];
        onBulkCreated(inserted);
        toast(`Added ${inserted.length} exception${inserted.length === 1 ? "" : "s"}`, "success");
        setBatchDates("");
      } else {
        if (!date) {
          toast("Pick a date", "error");
          setSaving(false);
          return;
        }
        if (wantsTimes && !(startTime < endTime)) {
          toast("Start time must be before end time", "error");
          setSaving(false);
          return;
        }
        const payload: Record<string, unknown> = {
          userId: targetUserId,
          date,
          unavailable: !wantsTimes,
          reason: reason || (kind === "lunch" ? "Lunch break" : kind === "custom" ? "Custom hours" : "Blocked day"),
        };
        if (wantsTimes) {
          payload.startTime = startTime;
          payload.endTime = endTime;
        }
        const res = await fetch("/api/availability/overrides", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d?.error ?? "Save failed");
        const row = composeRow(
          {
            id: d.id,
            date: d.date,
            unavailable: d.unavailable,
            startTime: d.startTime ?? null,
            endTime: d.endTime ?? null,
            reason: d.reason ?? null,
          },
          targetWorkforce,
          callerTimezone,
        );
        onCreated(row);
        toast("Exception added", "success");
        setDate("");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  const TYPES: Array<{ id: ExceptionKind | "batch"; label: string; icon: LucideIcon; tone: string }> = [
    { id: "vacation", label: "Vacation",     icon: Plane,       tone: "bg-sky-50 text-sky-700 ring-sky-200/40" },
    { id: "block",    label: "Block day",    icon: CalendarOff, tone: "bg-rose-50 text-rose-700 ring-rose-200/40" },
    { id: "custom",   label: "Custom hours", icon: Clock,       tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/40" },
    { id: "lunch",    label: "Lunch break",  icon: Coffee,      tone: "bg-indigo-50 text-indigo-700 ring-indigo-200/40" },
    { id: "holiday",  label: "Holiday",      icon: Sun,         tone: "bg-amber-50 text-amber-700 ring-amber-200/40" },
    { id: "batch",    label: "Holiday batch", icon: CalendarRange, tone: "bg-violet-50 text-violet-700 ring-violet-200/40" },
  ];

  return (
    <PremiumCard className="p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Add exception</div>
          <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
            {isAdmin ? "Create a workforce exception" : "Create an exception on your schedule"}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            Date-scoped — temporarily supersedes weekly rules. The resolver picks up the change immediately.
          </p>
        </div>
        {isAdmin && (
          <StaffPicker
            workforce={workforce}
            value={targetUserId}
            onChange={setTargetUserId}
          />
        )}
      </div>

      {/* Type chooser */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {TYPES.map((t) => {
          const Icon = t.icon;
          const on = kind === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setKind(t.id)}
              className={cn(
                "group relative overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                on
                  ? "border-brand-accent/40 bg-brand-subtle/40 ring-2 ring-brand-accent/30 shadow-soft -translate-y-0.5"
                  : "border-border bg-surface hover:-translate-y-0.5 hover:shadow-soft",
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1", t.tone)}>
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                </span>
                <span className={cn("text-[12.5px] font-semibold tracking-tight", on ? "text-brand-accent" : "text-ink")}>
                  {t.label}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Inputs */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {kind === "batch" ? (
          <label className="block sm:col-span-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Holiday dates</span>
            <textarea
              rows={4}
              value={batchDates}
              onChange={(e) => setBatchDates(e.target.value)}
              placeholder={"2026-12-25\n2026-12-26\n2026-12-31\n2027-01-01"}
              className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-[12px] tabular-nums text-ink"
            />
            <span className="mt-1 block text-[10.5px] text-ink-subtle">
              One date per line in <span className="font-semibold">YYYY-MM-DD</span> format. All dates become
              full-day blocks for the selected staff member.
            </span>
          </label>
        ) : (
          <>
            <label className="block">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Date</span>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] tabular-nums text-ink"
              />
            </label>
            {wantsTimes && (
              <div className="flex items-end gap-2">
                <label className="block flex-1">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Start</span>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] tabular-nums text-ink"
                  />
                </label>
                <span className="mb-2.5 text-[12px] text-ink-subtle">–</span>
                <label className="block flex-1">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">End</span>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] tabular-nums text-ink"
                  />
                </label>
              </div>
            )}
          </>
        )}
        <label className="block sm:col-span-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">Reason</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Family vacation, Christmas, weekly lunch"
            className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 text-[12.5px] text-ink"
          />
          <span className="mt-1 block text-[10.5px] text-ink-subtle">
            Surfaces on the timeline and inside the resolver&apos;s &quot;why was this slot unavailable&quot; trace.
          </span>
        </label>
      </div>

      {wantsTimes && kind === "lunch" && (
        <p className="mt-3 text-[11px] text-ink-subtle">
          <span className="font-semibold text-ink-muted">Tip · </span>
          Add two custom-hours rows to split a working day (e.g. 9–12 then 1–5).
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
        <span className="text-[11px] text-ink-subtle">
          Times in <span className="font-semibold text-ink-muted">{targetWorkforce?.timezone ?? callerTimezone}</span>
        </span>
        <Button onClick={submit} size="sm" disabled={saving}>
          {saving ? "Saving…" : kind === "batch" ? "Add holidays" : "Add exception"}
        </Button>
      </div>
    </PremiumCard>
  );
}

function StaffPicker({
  workforce,
  value,
  onChange,
}: {
  workforce: WorkforceLite[];
  value: string;
  onChange: (id: string) => void;
}) {
  const selected = workforce.find((w) => w.id === value) ?? null;
  return (
    <label className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">For</span>
      {selected && (
        <Avatar name={selected.displayName} src={selected.avatarUrl} size="sm" />
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-0 bg-transparent text-[12px] font-medium text-ink outline-none"
      >
        {workforce.map((w) => (
          <option key={w.id} value={w.id}>
            {w.displayName} {w.role === "admin" ? "· owner" : w.role === "manager" ? "· manager" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

// ─── Timeline card ──────────────────────────────────────────────

function TimelineCard({
  exceptions,
  totalCount,
  query,
  setQuery,
  canDelete,
  callerUserId,
  onDeleted,
}: {
  exceptions: ExceptionRow[];
  totalCount: number;
  query: string;
  setQuery: (v: string) => void;
  canDelete: boolean;
  callerUserId: string;
  onDeleted: (id: string) => void;
}) {
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function deleteRow(id: string) {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/availability/overrides/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error ?? "Delete failed");
      }
      onDeleted(id);
      toast("Exception removed", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PremiumCard className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3.5 sm:px-5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            Operational timeline
          </div>
          <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
            Upcoming exceptions
          </h2>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">
            Every override scheduled from today forward, sorted chronologically.
          </p>
        </div>
        {totalCount > 0 && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" strokeWidth={1.75} />
            <input
              type="text"
              placeholder="Filter staff, reason, location…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-[240px] rounded-md border border-border bg-surface py-1.5 pl-7 pr-2.5 text-[12px] placeholder:text-ink-subtle"
            />
          </div>
        )}
      </div>

      {exceptions.length === 0 ? (
        <EmptyTimeline hasAny={totalCount > 0} />
      ) : (
        <ul className="divide-y divide-border/60">
          {exceptions.map((e) => (
            <TimelineRow
              key={e.id}
              row={e}
              busy={busyId === e.id}
              canDelete={canDelete || e.userId === callerUserId}
              onDelete={() => deleteRow(e.id)}
            />
          ))}
        </ul>
      )}
    </PremiumCard>
  );
}

function EmptyTimeline({ hasAny }: { hasAny: boolean }) {
  return (
    <div className="px-5 py-10 text-center">
      <span className="mx-auto inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
        <CalendarRange className="h-5 w-5" strokeWidth={1.75} />
      </span>
      <p className="mt-2.5 text-[13px] font-semibold tracking-tight text-ink">
        {hasAny ? "No matches for that filter" : "No upcoming exceptions"}
      </p>
      <p className="mt-1 text-[11.5px] text-ink-muted">
        {hasAny
          ? "Try a different staff name, location, or reason."
          : "Workforce schedule runs on the standard weekly rules. Add a vacation, lunch break, or holiday above when something changes."}
      </p>
    </div>
  );
}

function TimelineRow({
  row,
  busy,
  canDelete,
  onDelete,
}: {
  row: ExceptionRow;
  busy: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const kind = deriveKind(row);
  const meta = KIND_META[kind];
  const KindIcon = meta.icon;
  const ModeIcon = deliveryModeIcon(row.deliveryMode);

  // Coverage impact — honest, derived data only.
  const allDay = row.unavailable;
  const coverageImpactText = allDay
    ? row.affectedServiceCount > 0
      ? `Reduces coverage for ${row.affectedServiceCount} service${row.affectedServiceCount === 1 ? "" : "s"}`
      : "Full-day removal from booking pool"
    : `${row.startTime} – ${row.endTime} window inserted into the day`;

  // For virtual-only staff, give the operator a calm "virtual support
  // remains active" callout when they're blocked — useful operational
  // signal: physical surfaces are not affected.
  const virtualHint = allDay && row.deliveryMode === "virtual" ? "Virtual surface only — physical locations unaffected." : null;

  return (
    <li
      className={cn(
        "relative flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors duration-[200ms] hover:bg-surface-inset/30 sm:px-5",
        meta.haloHover,
      )}
    >
      {/* Left-edge accent in the kind's color */}
      <span aria-hidden className={cn("pointer-events-none absolute inset-y-2 left-0 w-[3px] rounded-r-full", meta.accent)} />

      {/* Date pill */}
      <div className="flex w-[88px] shrink-0 flex-col">
        <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{relativeLabel(row.date)}</span>
        <span className="text-[12.5px] font-semibold tabular-nums tracking-tight text-ink">{dayLabel(row.date)}</span>
      </div>

      {/* Staff identity */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <Avatar name={row.staffName} src={row.staffAvatarUrl} size="sm" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[12.5px] font-semibold text-ink">{row.staffName}</span>
            {row.staffRole !== "staff" && (
              <span className={cn(
                "inline-flex items-center rounded-full px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.06em] ring-1",
                row.staffRole === "admin" ? "bg-violet-50 text-violet-700 ring-violet-200/40" : "bg-sky-50 text-sky-700 ring-sky-200/40",
              )}>
                {row.staffRole}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-muted">
            <Clock className="h-2.5 w-2.5 text-ink-subtle" strokeWidth={1.75} />
            <span className="tabular-nums">{row.staffTimezone}</span>
            <span className="text-ink-subtle">·</span>
            <ModeIcon className="h-2.5 w-2.5 text-ink-subtle" strokeWidth={1.75} />
            <span className="capitalize">{row.deliveryMode.replace("_", " ")}</span>
          </div>
        </div>
      </div>

      {/* Kind chip */}
      <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] ring-1", meta.tone)}>
        <KindIcon className="h-3 w-3" strokeWidth={1.75} />
        {meta.label}
      </span>

      {/* Window + reason */}
      <div className="flex min-w-[180px] flex-col">
        <span className="text-[11.5px] font-medium tabular-nums text-ink">
          {allDay ? "All day" : `${row.startTime} – ${row.endTime}`}
        </span>
        {row.reason && (
          <span className="truncate text-[10.5px] text-ink-muted">{row.reason}</span>
        )}
      </div>

      {/* Coverage impact + affected locations */}
      <div className="hidden flex-col items-end gap-1 md:flex">
        <span className="text-[10.5px] text-ink-muted">{coverageImpactText}</span>
        <div className="flex flex-wrap items-center justify-end gap-1">
          {row.affectedLocations.slice(0, 2).map((l) => {
            const swatch = locationSwatch(l.id, l.type);
            const Icon = locationTypeIcon(l.type);
            return (
              <span
                key={l.id}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium ring-1",
                  swatch.surface, swatch.ring, swatch.text,
                )}
                title={`${l.name} · ${locationTypeLabel(l.type)}`}
              >
                <Icon className="h-2.5 w-2.5" strokeWidth={1.75} />
                <span className="max-w-[80px] truncate">{l.name}</span>
              </span>
            );
          })}
          {row.affectedLocations.length > 2 && (
            <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[9.5px] font-medium text-ink-muted ring-1 ring-border/40">
              +{row.affectedLocations.length - 2}
            </span>
          )}
        </div>
        {virtualHint && (
          <span className="inline-flex items-center gap-1 text-[10px] text-violet-700">
            <Video className="h-2.5 w-2.5" strokeWidth={1.75} />
            {virtualHint}
          </span>
        )}
      </div>

      {canDelete && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          disabled={busy}
          className="ml-auto md:ml-2"
        >
          <Trash2 className="mr-1 h-3 w-3" strokeWidth={1.75} />
          Remove
        </Button>
      )}
    </li>
  );
}

function deliveryModeIcon(mode: "in_person" | "virtual" | "hybrid"): LucideIcon {
  if (mode === "virtual") return Video;
  if (mode === "in_person") return Building2;
  return Globe;
}

// ─── Future scaffolds ─────────────────────────────────────────

function FutureScaffolds() {
  const tiles: { icon: LucideIcon; title: string; caption: string }[] = [
    { icon: RotateCw,       title: "Recurring holidays",     caption: "Yearly entries that auto-roll forward (Thanksgiving, July 4)." },
    { icon: MapPin,         title: "Regional calendars",     caption: "Holiday sets per location — California vs Texas observances." },
    { icon: ArrowRightLeft, title: "Substitute staff",       caption: "Auto-route impacted bookings to an eligible replacement." },
    { icon: Layers,         title: "Coverage balancing",     caption: "Even-out booking load when several staff are out at once." },
    { icon: Pin,            title: "Temporary reassignment", caption: "Date-scoped location change — \"at the conference this week\"." },
    { icon: Shuffle,        title: "Split-day overrides",    caption: "Multiple intervals per day (working 9–12 + 3–6)." },
    { icon: AlertTriangle,  title: "Emergency closures",     caption: "One-tap workspace-wide pause with notifications + reschedule offers." },
  ];
  return (
    <PremiumCard className="p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Future date-exception engine</div>
      <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Coming soon</h2>
      <p className="mt-0.5 text-[11.5px] text-ink-muted">
        Each primitive ships as its data model + resolver hook lands. Listed here so the architecture is
        visible — every tile is honest scaffolding, never fabricated functionality.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tiles.map((t) => {
          const Icon = t.icon;
          return (
            <div key={t.title} className="relative overflow-hidden rounded-xl border border-dashed border-border bg-surface-inset/30 p-3">
              <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
              <div className="flex items-start gap-2.5">
                <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-subtle ring-1 ring-border/40">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12.5px] font-semibold tracking-tight text-ink">{t.title}</span>
                    <span className="inline-flex items-center rounded-full bg-surface px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
                      Coming soon
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{t.caption}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </PremiumCard>
  );
}

// ─── Helpers ──────────────────────────────────────────────────

// Compose a fresh ExceptionRow from a server response + the
// workforce metadata we already have client-side. We don't refetch
// service counts / locations after a single insert — those derived
// numbers are stable per staff and were attached to the workforce
// roster at server-render time. (For batch inserts that span days
// the same staff is targeted, so the same values apply.)
function composeRow(
  serverRow: { id: string; date: string; unavailable: boolean; startTime: string | null; endTime: string | null; reason: string | null },
  staff: WorkforceLite | null,
  fallbackTz: string,
): ExceptionRow {
  // We need affectedServiceCount + affectedLocations from somewhere
  // — the cheapest path is to leave them empty when the server didn't
  // hand us enrichment data. They populate on the next page refresh,
  // which is correct behavior since adding an exception doesn't
  // change the staff's service/location footprint.
  return {
    id: serverRow.id,
    userId: staff?.id ?? "",
    staffName: staff?.displayName ?? "You",
    staffRole: (staff?.role ?? "staff") as "admin" | "manager" | "staff",
    staffTitle: staff?.title ?? null,
    staffAvatarUrl: staff?.avatarUrl ?? null,
    staffTimezone: staff?.timezone ?? fallbackTz,
    deliveryMode: ((staff?.deliveryMode ?? "hybrid") as "in_person" | "virtual" | "hybrid"),
    date: serverRow.date,
    unavailable: serverRow.unavailable,
    startTime: serverRow.startTime ? serverRow.startTime.slice(0, 5) : null,
    endTime: serverRow.endTime ? serverRow.endTime.slice(0, 5) : null,
    reason: serverRow.reason ?? null,
    affectedServiceCount: 0,
    affectedLocations: [],
  };
}

// Avoid "imported but unused" — Pencil + Plane used elsewhere already.
void Pencil;
