"use client";

import * as React from "react";
import {
  Calendar,
  Clock,
  Copy,
  Users,
  Pencil,
  CheckCircle2,
  Building2,
  Video,
  Globe,
  Layers,
  Pin,
  Plane,
  Sun,
  RotateCw,
  Scale,
  CalendarOff,
  X,
  ChevronRight,
  Search,
  type LucideIcon,
} from "lucide-react";

import { Avatar, Button, Drawer, Skeleton, toast } from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import type { DayWindow, DefaultWorkspaceHours } from "@/lib/workspace-hours";
import {
  locationSwatch,
  locationTypeIcon,
  locationTypeLabel,
  type LocationType,
} from "@/lib/location-visual";

// ─── Workforce Availability Intelligence Center ──────────────────
//
// What this page is:
//   • The single operational surface for the tenant's workforce
//     availability hierarchy:
//       Workspace Hours → Staff Overrides → Location Presence → Mode
//   • An EDITOR for workspace hours (preserved from prior version)
//   • A LIST + DRAWER editor for per-staff schedule, location, mode
//
// What this page is NOT (Phase 16C strict rules):
//   • A booking engine rewrite — slot generator is untouched
//   • An availability resolver rewrite — lib/availability is untouched
//   • A routing rewrite — eligibility/orchestrator unchanged
//   • A migration — no schema/API changes
//
// Editing surfaces (all existing endpoints):
//   • PUT /api/tenant/workspace-hours   — tenant default
//   • PUT /api/availability?userId=...  — staff weekly rules
//   • PUT /api/staff/[id]/locations     — staff location pivot
//   • PATCH /api/staff/[id]             — delivery mode

// ─── Public types (consumed by page.tsx) ──────────────────────────

export type AssignmentRow = {
  locationId: string;
  locationName: string;
  locationType: LocationType;
  daysOfWeek: Array<"0" | "1" | "2" | "3" | "4" | "5" | "6">;
  isPrimary: boolean;
};

export type WorkforceMember = {
  id: string;
  name: string;
  displayName: string;
  title: string | null;
  email: string;
  role: "admin" | "manager" | "staff";
  timezone: string;
  avatarUrl: string | null;
  deliveryMode: "in_person" | "virtual" | "hybrid";
  /** True when the user has at least one row in `availability`. */
  hasCustomSchedule: boolean;
  assignments: AssignmentRow[];
};

type KpiBundle = {
  inheritingCount: number;
  customCount: number;
  workforceCount: number;
  virtualCapableCount: number;
  activeLocationsCount: number;
  coveragePct: number;
  workspaceHasOpenDay: boolean;
};

// ─── Day-of-week constants ────────────────────────────────────────

type DayKey = "0" | "1" | "2" | "3" | "4" | "5" | "6";

const DAYS_ORDER: { key: DayKey; label: string; short: string }[] = [
  { key: "1", label: "Monday",    short: "Mon" },
  { key: "2", label: "Tuesday",   short: "Tue" },
  { key: "3", label: "Wednesday", short: "Wed" },
  { key: "4", label: "Thursday",  short: "Thu" },
  { key: "5", label: "Friday",    short: "Fri" },
  { key: "6", label: "Saturday",  short: "Sat" },
  { key: "0", label: "Sunday",    short: "Sun" },
];

// ─── Workspace hours editor draft ─────────────────────────────────

type DraftDay = { open: boolean; start: string; end: string };
type Draft = Record<DayKey, DraftDay>;

function makeDraft(hours: DefaultWorkspaceHours): Draft {
  const out = {} as Draft;
  for (const { key } of DAYS_ORDER) {
    const v = hours[key];
    if (v && typeof v === "object") {
      out[key] = { open: true, start: v.start, end: v.end };
    } else {
      out[key] = { open: false, start: "09:00", end: "17:00" };
    }
  }
  return out;
}

function draftToHours(d: Draft): DefaultWorkspaceHours {
  const out: DefaultWorkspaceHours = {};
  for (const { key } of DAYS_ORDER) {
    const day = d[key];
    out[key] = day.open ? { start: day.start, end: day.end } : null;
  }
  return out;
}

function hoursEqual(a: Draft, b: Draft): boolean {
  for (const { key } of DAYS_ORDER) {
    if (a[key].open !== b[key].open) return false;
    if (a[key].open) {
      if (a[key].start !== b[key].start) return false;
      if (a[key].end !== b[key].end) return false;
    }
  }
  return true;
}

// ─── Top-level component ──────────────────────────────────────────

export default function WorkspaceHoursClient({
  initial,
  canEdit,
  kpis,
  workforce,
  tenantTimezone,
}: {
  initial: DefaultWorkspaceHours;
  canEdit: boolean;
  kpis: KpiBundle;
  workforce: WorkforceMember[];
  tenantTimezone: string;
}) {
  // Workspace hours draft / baseline.
  const [draft, setDraft] = React.useState<Draft>(() => makeDraft(initial));
  const [baseline, setBaseline] = React.useState<Draft>(() => makeDraft(initial));
  const [saving, setSaving] = React.useState(false);

  // Live KPI state — only `inheritingCount` shifts as workforce
  // hours flip; the rest are stable until the page refetches. We
  // keep a local copy so the chip refreshes immediately on save.
  const [liveInheritingCount, setLiveInheritingCount] = React.useState(kpis.inheritingCount);

  // Drawer open state.
  const [editingStaffId, setEditingStaffId] = React.useState<string | null>(null);
  const [workforceState, setWorkforceState] = React.useState<WorkforceMember[]>(workforce);

  // Search filter on the coverage table.
  const [query, setQuery] = React.useState("");

  const dirty = !hoursEqual(draft, baseline);
  const openDays = DAYS_ORDER.filter(({ key }) => draft[key].open).length;
  const hasAny = openDays > 0;

  function toggleDay(key: DayKey, on: boolean) {
    setDraft((d) => ({ ...d, [key]: { ...d[key], open: on } }));
  }
  function setTime(key: DayKey, field: "start" | "end", value: string) {
    setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } }));
  }
  function copyToWeekdays() {
    const mon = draft["1"];
    setDraft((d) => {
      const next = { ...d };
      (["2", "3", "4", "5"] as const).forEach((k) => {
        next[k] = { ...mon };
      });
      return next;
    });
  }
  function copyToAll() {
    const mon = draft["1"];
    setDraft((d) => {
      const next = { ...d };
      for (const { key } of DAYS_ORDER) next[key] = { ...mon };
      return next;
    });
  }
  function reset() {
    setDraft(baseline);
  }

  async function save() {
    if (!canEdit || !dirty) return;
    for (const { key, label } of DAYS_ORDER) {
      const day = draft[key];
      if (day.open && !(day.start < day.end)) {
        toast(`${label}: start time must be before end time`, "error");
        return;
      }
    }
    setSaving(true);
    try {
      const payload = draftToHours(draft);
      const res = await fetch("/api/tenant/workspace-hours", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Save failed");
      setBaseline(draft);
      toast("Workspace hours saved", "success");
      try {
        const r = await fetch("/api/tenant/workspace-hours");
        if (r.ok) {
          const d2 = await r.json();
          if (typeof d2?.inheritingStaffCount === "number") {
            setLiveInheritingCount(d2.inheritingStaffCount);
          }
        }
      } catch {
        // best-effort
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  // ─── Drawer save callback ─────────────────────────────────────
  // The drawer mutates per-staff state via the existing endpoints
  // and reports back the resulting shape so the table can update
  // without a full page refetch.
  function applyDrawerChange(
    staffId: string,
    patch: Partial<Pick<WorkforceMember, "deliveryMode" | "hasCustomSchedule" | "assignments">>,
  ) {
    setWorkforceState((cur) =>
      cur.map((m) => (m.id === staffId ? { ...m, ...patch } : m)),
    );
  }

  // Filter the workforce table by free-text query. We match name,
  // email, title, role, and assignment names so a manager can find
  // "Sean" or "downtown" or "virtual" instantly.
  const filteredWorkforce = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workforceState;
    return workforceState.filter((m) => {
      if (m.displayName.toLowerCase().includes(q)) return true;
      if (m.email.toLowerCase().includes(q)) return true;
      if (m.role.toLowerCase().includes(q)) return true;
      if ((m.title ?? "").toLowerCase().includes(q)) return true;
      if (m.deliveryMode.replace("_", " ").includes(q)) return true;
      for (const a of m.assignments) {
        if (a.locationName.toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }, [workforceState, query]);

  // Currently-edited staff member (if any).
  const editingStaff = editingStaffId
    ? workforceState.find((m) => m.id === editingStaffId) ?? null
    : null;

  return (
    <div className="space-y-5 pb-24">
      {/* ── Hero ─────────────────────────────────────────────── */}
      <WorkforceHero
        title="Workforce availability"
        subtitle="Define the operational hours your workspace runs on. Staff can inherit these hours or override them individually — every layer below stays composable."
        timezone={tenantTimezone}
      />

      {/* ── Quick guide: Working hours vs Overrides vs Show Fewer Open Slots ── */}
      <PremiumCard className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          Quick guide
        </div>
        <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
          How availability works
        </h2>
        <ul className="mt-3 space-y-2.5">
          <li className="flex items-start gap-2.5">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent" strokeWidth={2} />
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              Use <span className="font-medium text-ink">Working hours</span> to set real weekly availability.
            </p>
          </li>
          <li className="flex items-start gap-2.5">
            <CalendarOff className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent" strokeWidth={2} />
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              Use <span className="font-medium text-ink">Overrides</span> for one-time changes like time off, blocked time, vacations, or special hours.
            </p>
          </li>
          <li className="flex items-start gap-2.5">
            <Layers className="mt-0.5 h-4 w-4 shrink-0 text-brand-accent" strokeWidth={2} />
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              Use <span className="font-medium text-ink">Show Fewer Open Slots</span> from a staff profile only when you want clients to see fewer public booking options without changing real internal availability.
            </p>
          </li>
        </ul>
      </PremiumCard>

      {/* ── Hierarchy diagram ────────────────────────────────── */}
      <HierarchyDiagram />

      {/* ── KPI row ─────────────────────────────────────────── */}
      <KpiRow
        kpis={{
          ...kpis,
          inheritingCount: liveInheritingCount,
        }}
      />

      {/* ── Workspace hours editor ──────────────────────────── */}
      <PremiumCard className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Layer 1 · Workspace hours
            </div>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
              Default operational hours
            </h2>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              The fallback weekly schedule every workforce member inherits unless they configure custom hours.
            </p>
          </div>
          {canEdit && (
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={copyToWeekdays} disabled={saving}>
                <Copy className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
                Copy Mon to weekdays
              </Button>
              <Button variant="ghost" size="sm" onClick={copyToAll} disabled={saving}>
                <Copy className="mr-1.5 h-3.5 w-3.5" strokeWidth={2} />
                Copy to all days
              </Button>
            </div>
          )}
        </div>

        <div className="mt-3 space-y-2">
          {DAYS_ORDER.map(({ key, label }) => {
            const day = draft[key];
            return (
              <div
                key={key}
                className={cn(
                  "group flex items-center gap-3 rounded-xl border bg-surface px-3.5 py-2.5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                  day.open
                    ? "border-border hover:border-border-strong"
                    : "border-border/60 bg-surface-inset/30",
                )}
              >
                <DayToggle
                  on={day.open}
                  onChange={(on) => toggleDay(key, on)}
                  disabled={!canEdit || saving}
                />
                <div className="w-24 shrink-0 text-[13px] font-medium text-ink">{label}</div>
                {day.open ? (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <TimeInput value={day.start} onChange={(v) => setTime(key, "start", v)} disabled={!canEdit || saving} />
                    <span className="text-[12px] text-ink-subtle">–</span>
                    <TimeInput value={day.end} onChange={(v) => setTime(key, "end", v)} disabled={!canEdit || saving} />
                  </div>
                ) : (
                  <div className="flex-1 text-[11.5px] uppercase tracking-[0.10em] text-ink-subtle">Closed</div>
                )}
              </div>
            );
          })}
        </div>
      </PremiumCard>

      {/* ── Inheritance behavior preview (only when configured) ── */}
      {hasAny && (
        <PremiumCard className="p-4">
          <div className="flex items-start gap-3">
            <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15">
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div>
              <div className="text-[12.5px] font-semibold tracking-tight text-ink">Inheritance behavior</div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
                Staff with no rows in their own weekly schedule inherit these hours. Per-staff overrides — when present — always win over this fallback.
                Per-date overrides (vacations, custom days) continue to apply on top.
              </p>
            </div>
          </div>
        </PremiumCard>
      )}

      {/* ── Staff scheduling coverage ───────────────────────── */}
      <PremiumCard className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 px-4 py-3.5 sm:px-5">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Layer 2 · Staff scheduling coverage
            </div>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
              Who&apos;s available, where, and how
            </h2>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              One row per workforce member. Inherited or custom schedule, assigned locations, and delivery model — at a glance.
            </p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" strokeWidth={1.75} />
            <input
              type="text"
              placeholder="Filter staff, role, location…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-[220px] rounded-md border border-border bg-surface py-1.5 pl-7 pr-2.5 text-[12px] placeholder:text-ink-subtle"
            />
          </div>
        </div>

        <div className="divide-y divide-border/60">
          {filteredWorkforce.length === 0 && (
            <div className="px-5 py-10 text-center">
              <Users className="mx-auto h-5 w-5 text-ink-subtle" strokeWidth={1.5} />
              <p className="mt-2 text-[12.5px] text-ink-muted">
                {workforceState.length === 0
                  ? "No workforce members in this workspace yet."
                  : "No matches for that filter."}
              </p>
            </div>
          )}

          {filteredWorkforce.map((m) => (
            <StaffCoverageRow
              key={m.id}
              member={m}
              workspaceHasOpenDay={kpis.workspaceHasOpenDay}
              canEdit={canEdit}
              onEdit={() => setEditingStaffId(m.id)}
            />
          ))}
        </div>
      </PremiumCard>

      {/* ── Future scaffolds ──────────────────────────────── */}
      <FutureScaffolds />

      {/* ── Save bar (workspace hours) ────────────────────── */}
      {canEdit && (
        <div
          className={cn(
            "pointer-events-none sticky bottom-0 left-0 right-0 -mx-5 mt-3 flex translate-y-2 items-center justify-between gap-3 border-t border-border bg-surface/95 px-5 py-3 opacity-0 shadow-[0_-10px_24px_rgba(15,23,42,0.06)] backdrop-blur transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            dirty && "pointer-events-auto translate-y-0 opacity-100",
          )}
          aria-hidden={!dirty}
        >
          <span className="text-[12px] text-ink-muted">
            <Pencil className="mr-1 inline-block h-3 w-3 text-brand-accent" strokeWidth={2} />
            Unsaved workspace hours
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={reset} disabled={saving || !dirty}>
              Reset
            </Button>
            <Button onClick={save} size="sm" disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save workspace hours"}
            </Button>
          </div>
        </div>
      )}

      {!canEdit && (
        <p className="text-center text-[11.5px] text-ink-subtle">
          Read-only. Admins and managers can edit workspace hours.
        </p>
      )}

      {/* ── Staff schedule drawer ────────────────────────── */}
      <StaffScheduleDrawer
        staff={editingStaff}
        canEdit={canEdit}
        workspaceHours={initial}
        onClose={() => setEditingStaffId(null)}
        onChange={(patch) => {
          if (!editingStaffId) return;
          applyDrawerChange(editingStaffId, patch);
        }}
      />
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────

function WorkforceHero({
  title,
  subtitle,
  timezone,
}: {
  title: string;
  subtitle: string;
  timezone: string;
}) {
  return (
    <PremiumCard className="relative overflow-hidden p-5">
      <span aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-accent/12 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-12 bottom-0 h-32 w-32 rounded-full bg-violet-500/8 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <div className="relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-brand-subtle/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent ring-1 ring-brand-accent/15">
            Workforce availability intelligence
          </div>
          <h1 className="mt-2.5 text-[22px] font-semibold tracking-tight text-ink sm:text-[24px]">{title}</h1>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">{subtitle}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-border bg-surface/80 px-2.5 py-1 text-[11px] font-medium text-ink-muted shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:self-end">
          <Clock className="h-3 w-3 text-brand-accent" strokeWidth={2} />
          Tenant timezone <span className="font-semibold text-ink">{timezone}</span>
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
      icon: Calendar,
      title: "Workspace hours",
      caption: "Tenant-level default schedule.",
      tone: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/20",
    },
    {
      idx: 2,
      icon: Users,
      title: "Staff overrides",
      caption: "Per-user weekly rules override defaults.",
      tone: "bg-amber-50 text-amber-700 ring-amber-200/40",
    },
    {
      idx: 3,
      icon: Pin,
      title: "Location presence",
      caption: "Per-day location pivot decides where.",
      tone: "bg-sky-50 text-sky-700 ring-sky-200/40",
    },
    {
      idx: 4,
      icon: Layers,
      title: "Delivery mode",
      caption: "Virtual, in-person, hybrid surfaces.",
      tone: "bg-violet-50 text-violet-700 ring-violet-200/40",
    },
  ];
  return (
    <PremiumCard className="p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Availability hierarchy</div>
      <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">How the workforce stack composes</h2>
      <p className="mt-0.5 text-[11.5px] text-ink-muted">
        Each layer informs the layer above without replacing it. The booking engine reads the resolved answer; you orchestrate it here.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {layers.map((l, i) => {
          const Icon = l.icon;
          return (
            <div
              key={l.idx}
              className="relative flex items-start gap-2.5 rounded-xl border border-border bg-surface p-3 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
            >
              {/* Step number ribbon */}
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
              {/* Chevron between cards on desktop */}
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
  const items: Array<{
    icon: LucideIcon;
    label: string;
    value: string;
    sub?: string;
    tone: string;
  }> = [
    {
      icon: Users,
      label: "Inheriting defaults",
      value: String(kpis.inheritingCount),
      sub: kpis.workforceCount > 0 ? `of ${kpis.workforceCount}` : undefined,
      tone: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/15",
    },
    {
      icon: Pencil,
      label: "Custom overrides",
      value: String(kpis.customCount),
      sub: kpis.workforceCount > 0 ? `of ${kpis.workforceCount}` : undefined,
      tone: "bg-amber-50 text-amber-700 ring-amber-200/40",
    },
    {
      icon: Video,
      label: "Virtual capable",
      value: String(kpis.virtualCapableCount),
      sub: kpis.workforceCount > 0 ? `of ${kpis.workforceCount}` : undefined,
      tone: "bg-violet-50 text-violet-700 ring-violet-200/40",
    },
    {
      icon: Building2,
      label: "Active locations",
      value: String(kpis.activeLocationsCount),
      tone: "bg-emerald-50 text-emerald-700 ring-emerald-200/40",
    },
    {
      icon: Layers,
      label: "Booking coverage",
      value: `${kpis.coveragePct}%`,
      sub: kpis.workspaceHasOpenDay ? "of workforce bookable" : "no workspace hours",
      tone: kpis.coveragePct >= 80
        ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
        : kpis.coveragePct >= 50
          ? "bg-amber-50 text-amber-700 ring-amber-200/40"
          : "bg-rose-50 text-rose-700 ring-rose-200/40",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
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

// ─── Staff coverage row ────────────────────────────────────────

function StaffCoverageRow({
  member,
  workspaceHasOpenDay,
  canEdit,
  onEdit,
}: {
  member: WorkforceMember;
  workspaceHasOpenDay: boolean;
  canEdit: boolean;
  onEdit: () => void;
}) {
  // Schedule status — three honest signals only.
  const scheduleStatus: { label: string; tone: string } = member.hasCustomSchedule
    ? { label: "Custom schedule", tone: "bg-amber-50 text-amber-700 ring-amber-200/40" }
    : workspaceHasOpenDay
      ? { label: "Inheriting workspace", tone: "bg-brand-subtle/70 text-brand-accent ring-brand-accent/20" }
      : { label: "No schedule", tone: "bg-rose-50 text-rose-700 ring-rose-200/40" };

  const ModeIcon = deliveryModeIcon(member.deliveryMode);
  const modeTone = deliveryModeTone(member.deliveryMode);

  // Show up to 3 location chips; collapse the rest into a "+N" pill.
  const visibleAssignments = member.assignments.slice(0, 3);
  const overflow = member.assignments.length - visibleAssignments.length;

  return (
    <div className="group flex flex-wrap items-center gap-3 px-4 py-3.5 transition-colors duration-[200ms] hover:bg-surface-inset/30 sm:px-5">
      {/* Identity */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={member.displayName} src={member.avatarUrl} size="md" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-ink">{member.displayName}</span>
            <RoleBadge role={member.role} />
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
            {member.title && <span className="truncate">{member.title}</span>}
            {member.title && <span className="text-ink-subtle">·</span>}
            <Clock className="h-2.5 w-2.5 text-ink-subtle" strokeWidth={1.75} />
            <span className="tabular-nums">{member.timezone}</span>
          </div>
        </div>
      </div>

      {/* Schedule status */}
      <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] ring-1", scheduleStatus.tone)}>
        {scheduleStatus.label}
      </span>

      {/* Delivery mode */}
      <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold capitalize ring-1", modeTone)}>
        <ModeIcon className="h-3 w-3" strokeWidth={1.75} />
        {member.deliveryMode.replace("_", " ")}
      </span>

      {/* Location chips */}
      <div className="flex flex-wrap items-center gap-1">
        {visibleAssignments.length === 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 text-[10.5px] text-ink-subtle ring-1 ring-border/40">
            no locations
          </span>
        )}
        {visibleAssignments.map((a) => {
          const swatch = locationSwatch(a.locationId, a.locationType);
          const Icon = locationTypeIcon(a.locationType);
          return (
            <span
              key={a.locationId}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1",
                swatch.surface,
                swatch.ring,
                swatch.text,
              )}
              title={a.locationName}
            >
              <Icon className="h-2.5 w-2.5" strokeWidth={1.75} />
              <span className="max-w-[88px] truncate">{a.locationName}</span>
              {a.isPrimary && (
                <span className={cn("ml-0.5 inline-block h-1 w-1 rounded-full", swatch.dot)} aria-hidden />
              )}
            </span>
          );
        })}
        {overflow > 0 && (
          <span className="inline-flex items-center rounded-full bg-surface-inset px-1.5 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-border/40">
            +{overflow}
          </span>
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onEdit}
        disabled={!canEdit}
        className="ml-auto opacity-80 transition-opacity duration-[180ms] group-hover:opacity-100"
      >
        <Pencil className="mr-1 h-3 w-3" strokeWidth={2} />
        Edit schedule
      </Button>
    </div>
  );
}

function RoleBadge({ role }: { role: "admin" | "manager" | "staff" }) {
  const tone =
    role === "admin"
      ? "bg-violet-50 text-violet-700 ring-violet-200/40"
      : role === "manager"
        ? "bg-sky-50 text-sky-700 ring-sky-200/40"
        : "bg-surface-inset text-ink-subtle ring-border/40";
  return (
    <span className={cn("inline-flex items-center rounded-full px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.06em] ring-1", tone)}>
      {role}
    </span>
  );
}

function deliveryModeIcon(mode: "in_person" | "virtual" | "hybrid"): LucideIcon {
  if (mode === "virtual") return Video;
  if (mode === "in_person") return Building2;
  return Globe;
}

function deliveryModeTone(mode: "in_person" | "virtual" | "hybrid"): string {
  if (mode === "virtual") return "bg-violet-50 text-violet-700 ring-violet-200/40";
  if (mode === "in_person") return "bg-amber-50 text-amber-700 ring-amber-200/40";
  return "bg-sky-50 text-sky-700 ring-sky-200/40";
}

// ─── Future scaffolds ─────────────────────────────────────────

function FutureScaffolds() {
  const tiles: { icon: LucideIcon; title: string; caption: string }[] = [
    { icon: Plane,       title: "Vacations",            caption: "Date-scoped time off that overrides weekly rules." },
    { icon: CalendarOff, title: "Temporary overrides",  caption: "Cover a sick day or shift coverage instantly." },
    { icon: Sun,         title: "Regional holidays",    caption: "Per-location holiday calendars that pause bookings." },
    { icon: RotateCw,    title: "Rotating schedules",   caption: "Alternating Mon/Wed/Fri vs Tue/Thu workweeks." },
    { icon: Layers,      title: "Split shifts",         caption: "Multiple intervals per day for lunch breaks + late hours." },
    { icon: Scale,       title: "Team coverage balance",caption: "Even-out booking volume across the workforce." },
  ];
  return (
    <PremiumCard className="p-4">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">Future workforce primitives</div>
      <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Coming soon</h2>
      <p className="mt-0.5 text-[11.5px] text-ink-muted">
        Date-scoped overrides + team-balancing primitives ship as their backends land. Listed here so the architecture is visible — no fabricated controls.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
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

// ─── Staff schedule drawer ────────────────────────────────────

type ScheduleRule = { dayOfWeek: number; startTime: string; endTime: string };

function StaffScheduleDrawer({
  staff,
  canEdit,
  workspaceHours,
  onClose,
  onChange,
}: {
  staff: WorkforceMember | null;
  canEdit: boolean;
  workspaceHours: DefaultWorkspaceHours;
  onClose: () => void;
  onChange: (patch: Partial<Pick<WorkforceMember, "deliveryMode" | "hasCustomSchedule" | "assignments">>) => void;
}) {
  const [loading, setLoading] = React.useState(false);
  const [rules, setRules] = React.useState<ScheduleRule[]>([]);
  const [draft, setDraft] = React.useState<Draft>(() => makeDraft({}));
  const [baseline, setBaseline] = React.useState<Draft>(() => makeDraft({}));
  const [useWorkspace, setUseWorkspace] = React.useState(false);
  const [savedUseWorkspace, setSavedUseWorkspace] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [deliveryMode, setDeliveryMode] = React.useState<"in_person" | "virtual" | "hybrid">("hybrid");
  const [modeSaving, setModeSaving] = React.useState(false);

  // "Show Fewer Open Slots" — client-facing PUBLIC slot display throttle
  // (migration 0075). Read/written via the SAME GET/PATCH /api/staff/[id]
  // this drawer already uses for delivery mode. Display-only — NEVER touches
  // real availability (sections A/B above) or the booking engine.
  type DisplayMode = "normal" | "balanced" | "limited" | "very_limited";
  const [showFewer, setShowFewer] = React.useState(false);
  const [displayMode, setDisplayMode] = React.useState<DisplayMode>("normal");
  const [minVisible, setMinVisible] = React.useState(3);
  const [displayBaseline, setDisplayBaseline] = React.useState<{
    showFewer: boolean;
    displayMode: DisplayMode;
    minVisible: number;
  }>({ showFewer: false, displayMode: "normal", minVisible: 3 });
  const [displaySaving, setDisplaySaving] = React.useState(false);

  const open = staff !== null;

  // When a new staff is selected, fetch their schedule + reset
  // local state. We rely on the existing GET /api/staff/[id] which
  // already returns weeklyAvailability + deliveryMode + assignments.
  React.useEffect(() => {
    if (!staff) return;
    setLoading(true);
    setDeliveryMode(staff.deliveryMode);
    fetch(`/api/staff/${staff.id}`)
      .then((r) => r.json())
      .then((d) => {
        const fetchedRules: ScheduleRule[] = Array.isArray(d?.weeklyAvailability)
          ? d.weeklyAvailability.map((r: { dayOfWeek: number; startTime: string; endTime: string }) => ({
              dayOfWeek: r.dayOfWeek,
              startTime: r.startTime,
              endTime: r.endTime,
            }))
          : [];
        setRules(fetchedRules);
        const startingDraft = rulesToDraft(fetchedRules);
        setDraft(startingDraft);
        setBaseline(startingDraft);
        const inheriting = fetchedRules.length === 0;
        setUseWorkspace(inheriting);
        setSavedUseWorkspace(inheriting);
        // Seed client-facing display settings from the same payload
        // (staff.* fields returned by GET /api/staff/[id]).
        const sf = d?.staff?.showFewerOpenSlots ?? false;
        const dm = (d?.staff?.availabilityDisplayMode ?? "normal") as DisplayMode;
        const mv = d?.staff?.minimumVisibleSlotsPerDay ?? 3;
        setShowFewer(sf);
        setDisplayMode(dm);
        setMinVisible(mv);
        setDisplayBaseline({ showFewer: sf, displayMode: dm, minVisible: mv });
      })
      .catch(() => {
        toast("Failed to load schedule", "error");
      })
      .finally(() => setLoading(false));
  }, [staff]);

  function setDayOpen(idx: number, on: boolean) {
    if (!canEdit) return;
    setDraft((d) => ({ ...d, [String(idx) as DayKey]: { ...d[String(idx) as DayKey], open: on } }));
  }
  function setDayTime(idx: number, field: "start" | "end", v: string) {
    if (!canEdit) return;
    setDraft((d) => ({ ...d, [String(idx) as DayKey]: { ...d[String(idx) as DayKey], [field]: v } }));
  }
  function flipToCustom() {
    if (!canEdit) return;
    setUseWorkspace(false);
    // Pre-fill from workspace defaults if the draft is empty.
    const hasAnyDraftOpen = DAYS_ORDER.some((d) => draft[d.key].open);
    if (!hasAnyDraftOpen) {
      const seeded = makeDraft(workspaceHours);
      const wsHasAny = DAYS_ORDER.some((d) => seeded[d.key].open);
      if (wsHasAny) setDraft(seeded);
    }
  }
  function flipToWorkspace() {
    if (!canEdit) return;
    setUseWorkspace(true);
  }

  const draftChanged = React.useMemo(() => {
    for (const { key } of DAYS_ORDER) {
      const a = draft[key];
      const b = baseline[key];
      if (a.open !== b.open) return true;
      if (a.open) {
        if (a.start !== b.start) return true;
        if (a.end !== b.end) return true;
      }
    }
    return false;
  }, [draft, baseline]);

  const dirty =
    useWorkspace !== savedUseWorkspace ||
    (!useWorkspace && draftChanged);

  async function saveSchedule() {
    if (!staff || !canEdit || !dirty) return;
    setSaving(true);
    try {
      let payloadRules: ScheduleRule[] = [];
      if (!useWorkspace) {
        for (const { key, label } of DAYS_ORDER) {
          const day = draft[key];
          if (day.open && !(day.start < day.end)) {
            toast(`${label}: start must be before end`, "error");
            setSaving(false);
            return;
          }
        }
        payloadRules = DAYS_ORDER.flatMap(({ key }) => {
          const day = draft[key];
          if (!day.open) return [];
          return [{ dayOfWeek: Number(key), startTime: day.start, endTime: day.end }];
        });
      }
      const res = await fetch(`/api/availability?userId=${staff.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: payloadRules }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Save failed");
      setBaseline(useWorkspace ? rulesToDraft([]) : { ...draft });
      setRules(payloadRules);
      setSavedUseWorkspace(useWorkspace);
      onChange({ hasCustomSchedule: !useWorkspace });
      toast(useWorkspace ? "Now using workspace hours" : "Custom schedule saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  async function saveDeliveryMode(next: "in_person" | "virtual" | "hybrid") {
    if (!staff || !canEdit) return;
    const prev = deliveryMode;
    setDeliveryMode(next);
    setModeSaving(true);
    try {
      const res = await fetch(`/api/staff/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryMode: next }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      onChange({ deliveryMode: next });
      toast("Delivery mode updated", "success");
    } catch (e) {
      setDeliveryMode(prev);
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setModeSaving(false);
    }
  }

  const displayDirty =
    showFewer !== displayBaseline.showFewer ||
    displayMode !== displayBaseline.displayMode ||
    minVisible !== displayBaseline.minVisible;

  async function saveDisplaySettings() {
    if (!staff || !canEdit || !displayDirty) return;
    setDisplaySaving(true);
    try {
      // SAME endpoint as delivery mode. Server enforces admin/manager
      // (requireRole) + the field schema — this UI cannot widen access.
      const res = await fetch(`/api/staff/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          showFewerOpenSlots: showFewer,
          availabilityDisplayMode: displayMode,
          minimumVisibleSlotsPerDay: minVisible,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed");
      setDisplayBaseline({ showFewer, displayMode, minVisible });
      toast("Client-facing display updated", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setDisplaySaving(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} side="right" size="xl" ariaLabel="Edit staff schedule">
      {!staff ? null : (
        <div className="flex h-full flex-col">
          {/* Header */}
          <div className="relative overflow-hidden border-b border-border bg-gradient-to-br from-brand-subtle/30 via-surface to-surface p-5">
            <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
            <div className="relative flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <Avatar name={staff.displayName} src={staff.avatarUrl} size="lg" />
                <div className="min-w-0">
                  <h2 className="truncate text-[17px] font-semibold tracking-tight text-ink">{staff.displayName}</h2>
                  {staff.title && <div className="text-[12px] text-ink-muted">{staff.title}</div>}
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
                    <Clock className="h-2.5 w-2.5" strokeWidth={1.75} />
                    {staff.timezone}
                    <RoleBadge role={staff.role} />
                  </div>
                </div>
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {loading ? (
              <>
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-36 w-full" />
                <Skeleton className="h-28 w-full" />
              </>
            ) : (
              <>
                {/* A. Schedule mode */}
                <PremiumCard className="p-4">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">A · Schedule mode</div>
                  <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Inherit workspace hours or set custom</h3>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    Per-staff schedules always win over the workspace fallback. Switching back to Inherit clears the override.
                  </p>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <ModeOptionCard
                      label="Inherit workspace hours"
                      caption="Use the tenant default — calm fallback for any day not customized."
                      icon={Calendar}
                      selected={useWorkspace}
                      onClick={flipToWorkspace}
                      disabled={!canEdit || saving}
                      tone="brand"
                    />
                    <ModeOptionCard
                      label="Custom availability"
                      caption="Override the workspace defaults with this staff's own schedule."
                      icon={Pencil}
                      selected={!useWorkspace}
                      onClick={flipToCustom}
                      disabled={!canEdit || saving}
                      tone="amber"
                    />
                  </div>
                </PremiumCard>

                {/* B. Weekly schedule */}
                <PremiumCard className="p-4">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">B · Weekly schedule</div>
                  <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
                    {useWorkspace ? "Workspace hours preview" : "Edit weekly hours"}
                  </h3>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    {useWorkspace
                      ? "Read-only — these are the workspace defaults this staff currently inherits."
                      : "Per-day intervals. Single window per day for now; multi-interval support is scaffolded for a future release."}
                  </p>
                  <div className="mt-3 space-y-2">
                    {DAYS_ORDER.map(({ key, label }) => {
                      const previewDay = useWorkspace ? makeDraft(workspaceHours)[key] : draft[key];
                      return (
                        <div
                          key={key}
                          className={cn(
                            "flex items-center gap-3 rounded-xl border bg-surface px-3.5 py-2 transition-colors duration-[200ms]",
                            previewDay.open ? "border-border" : "border-border/60 bg-surface-inset/30",
                          )}
                        >
                          <DayToggle
                            on={previewDay.open}
                            onChange={(on) => setDayOpen(Number(key), on)}
                            disabled={useWorkspace || !canEdit || saving}
                          />
                          <div className="w-20 shrink-0 text-[12.5px] font-medium text-ink">{label}</div>
                          {previewDay.open ? (
                            <div className="flex flex-1 flex-wrap items-center gap-2">
                              <TimeInput
                                value={previewDay.start}
                                onChange={(v) => setDayTime(Number(key), "start", v)}
                                disabled={useWorkspace || !canEdit || saving}
                              />
                              <span className="text-[12px] text-ink-subtle">–</span>
                              <TimeInput
                                value={previewDay.end}
                                onChange={(v) => setDayTime(Number(key), "end", v)}
                                disabled={useWorkspace || !canEdit || saving}
                              />
                            </div>
                          ) : (
                            <div className="flex-1 text-[10.5px] uppercase tracking-[0.10em] text-ink-subtle">Closed</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {/* Multi-interval scaffold note */}
                  <p className="mt-2 text-[10.5px] text-ink-subtle">
                    <span className="rounded-full bg-surface-inset px-1.5 py-0.5 font-semibold uppercase tracking-[0.06em] text-ink-muted ring-1 ring-border/40">Coming soon</span>{" "}
                    Multiple intervals per day (split shifts, lunch breaks).
                  </p>
                </PremiumCard>

                {/* C. Location presence */}
                <PremiumCard className="p-4">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">C · Location presence</div>
                  <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Where does this staff work each day?</h3>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    Per-day resolved location, day-pinned wins. Edit the assignment set on the staff Profile tab.
                  </p>
                  <WeeklyPresenceStrip assignments={staff.assignments} />
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="text-ink-subtle">Manage assignments:</span>
                    <a
                      href={`/dashboard/staff?focus=${staff.id}`}
                      className="inline-flex items-center gap-1 rounded-full bg-brand-subtle/70 px-2 py-0.5 font-semibold text-brand-accent ring-1 ring-brand-accent/20 hover:bg-brand-subtle"
                    >
                      Open in Staff
                      <ChevronRight className="h-3 w-3" strokeWidth={2} />
                    </a>
                  </div>
                </PremiumCard>

                {/* D. Delivery context */}
                <PremiumCard className="p-4">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">D · Delivery context</div>
                  <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">How does this staff meet clients?</h3>
                  <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <DeliveryOption
                      value="in_person"
                      label="In-person"
                      caption="Physical or hybrid locations."
                      icon={Building2}
                      selected={deliveryMode === "in_person"}
                      onClick={() => saveDeliveryMode("in_person")}
                      disabled={!canEdit || modeSaving}
                    />
                    <DeliveryOption
                      value="virtual"
                      label="Virtual"
                      caption="Online delivery — Virtual Hub auto-attached."
                      icon={Video}
                      selected={deliveryMode === "virtual"}
                      onClick={() => saveDeliveryMode("virtual")}
                      disabled={!canEdit || modeSaving}
                    />
                    <DeliveryOption
                      value="hybrid"
                      label="Hybrid"
                      caption="Mix of physical + virtual surfaces."
                      icon={Globe}
                      selected={deliveryMode === "hybrid"}
                      onClick={() => saveDeliveryMode("hybrid")}
                      disabled={!canEdit || modeSaving}
                    />
                  </div>
                </PremiumCard>

                {/* E. Client-facing availability display — PUBLIC slot throttle.
                    Display layer ONLY; visually separated from the real-schedule
                    cards (A/B) above. Saved via PATCH /api/staff/[id]. */}
                <PremiumCard className="p-4 ring-1 ring-border/40">
                  <div className="flex items-center gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                      E · Client-facing display
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-ink-muted ring-1 ring-border/40">
                      <Layers className="h-2.5 w-2.5" strokeWidth={2} aria-hidden /> Display only
                    </span>
                  </div>
                  <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
                    Client-facing availability display
                  </h3>
                  <p className="mt-0.5 text-[11.5px] text-ink-muted">
                    These settings control what clients see on the public booking page. They do not change this staff member&rsquo;s real internal availability.
                  </p>

                  <label className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
                    <span className="text-[12.5px] font-medium text-ink">Show Fewer Open Slots</span>
                    <input
                      type="checkbox"
                      checked={showFewer}
                      onChange={(e) => setShowFewer(e.target.checked)}
                      disabled={!canEdit || displaySaving}
                      className="h-4 w-4 accent-brand-accent disabled:opacity-50"
                    />
                  </label>

                  <div className={cn("mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2", !showFewer && "opacity-50")}>
                    <label className="block">
                      <span className="text-[11px] font-semibold text-ink-muted">Availability display</span>
                      <select
                        value={displayMode}
                        onChange={(e) => setDisplayMode(e.target.value as DisplayMode)}
                        disabled={!canEdit || !showFewer || displaySaving}
                        className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
                      >
                        <option value="normal">Normal — Show all available slots</option>
                        <option value="balanced">Balanced — Show fewer slots</option>
                        <option value="limited">Limited — Show limited slots</option>
                        <option value="very_limited">Very Limited — Show very few slots</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[11px] font-semibold text-ink-muted">Minimum visible slots per day</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={minVisible}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setMinVisible(Number.isFinite(n) ? Math.min(20, Math.max(1, Math.floor(n))) : 3);
                        }}
                        disabled={!canEdit || !showFewer || displaySaving}
                        className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-[13px] disabled:bg-surface-inset"
                      />
                    </label>
                  </div>

                  <p className="mt-2 text-[10.5px] text-ink-subtle">
                    Clients can only book the slots shown on the public booking page. Admins and staff can still book the full real availability internally.
                  </p>

                  {canEdit ? (
                    <div className="mt-3 flex items-center justify-end gap-2">
                      {displayDirty && (
                        <span className="text-[10.5px] text-ink-subtle">Unsaved display changes</span>
                      )}
                      <Button onClick={saveDisplaySettings} size="sm" disabled={!displayDirty || displaySaving}>
                        {displaySaving ? "Saving…" : "Save display settings"}
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-3 text-[10.5px] text-ink-subtle">
                      Read-only. Admins and managers manage the client-facing display.
                    </p>
                  )}
                </PremiumCard>

                <p className="px-1 text-center text-[10.5px] text-ink-subtle">
                  All changes save independently. Booking engine sees the new values immediately.
                </p>
              </>
            )}
          </div>

          {/* Footer save bar — only for schedule changes; mode/locations save inline */}
          {canEdit && (
            <div
              className={cn(
                "pointer-events-none flex translate-y-2 items-center justify-end gap-3 border-t border-border bg-surface/95 px-5 py-3 opacity-0 shadow-[0_-10px_24px_rgba(15,23,42,0.06)] backdrop-blur transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                dirty && "pointer-events-auto translate-y-0 opacity-100",
              )}
              aria-hidden={!dirty}
            >
              <Button onClick={saveSchedule} size="sm" disabled={saving || !dirty}>
                {saving ? "Saving…" : useWorkspace ? "Save (revert to workspace)" : "Save schedule"}
              </Button>
            </div>
          )}
          {!canEdit && (
            <div className="border-t border-border bg-surface px-5 py-3 text-center text-[11.5px] text-ink-subtle">
              Read-only. Admins and managers can edit staff schedules.
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ─── Drawer-internal sub-primitives ───────────────────────────

function ModeOptionCard({
  label,
  caption,
  icon: Icon,
  selected,
  onClick,
  disabled,
  tone,
}: {
  label: string;
  caption: string;
  icon: LucideIcon;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  tone: "brand" | "amber";
}) {
  const selectedRing =
    tone === "amber"
      ? "border-amber-300/60 bg-amber-50/60 ring-2 ring-amber-300/30 shadow-soft"
      : "border-brand-accent/40 bg-brand-subtle/40 ring-2 ring-brand-accent/30 shadow-soft";
  const iconTone =
    tone === "amber"
      ? "bg-amber-100 text-amber-700 ring-amber-300/40"
      : "bg-brand-accent/10 text-brand-accent ring-brand-accent/20";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative rounded-xl border px-3 py-3 text-left transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        selected ? selectedRing : "border-border bg-surface hover:-translate-y-0.5 hover:shadow-soft",
        disabled && "cursor-not-allowed opacity-70",
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1", selected ? iconTone : "bg-surface-inset text-ink-muted ring-border/40")}>
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-ink">{label}</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{caption}</p>
    </button>
  );
}

function DeliveryOption({
  value,
  label,
  caption,
  icon: Icon,
  selected,
  onClick,
  disabled,
}: {
  value: "in_person" | "virtual" | "hybrid";
  label: string;
  caption: string;
  icon: LucideIcon;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const ring =
    value === "virtual"
      ? "border-violet-300/60 bg-violet-50/60 ring-2 ring-violet-300/30"
      : value === "in_person"
        ? "border-amber-300/60 bg-amber-50/60 ring-2 ring-amber-300/30"
        : "border-sky-300/60 bg-sky-50/60 ring-2 ring-sky-300/30";
  const iconTone =
    value === "virtual"
      ? "bg-violet-100 text-violet-700 ring-violet-300/40"
      : value === "in_person"
        ? "bg-amber-100 text-amber-700 ring-amber-300/40"
        : "bg-sky-100 text-sky-700 ring-sky-300/40";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "relative overflow-hidden rounded-xl border px-3 py-3 text-left transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        selected ? cn(ring, "shadow-soft -translate-y-0.5") : "border-border bg-surface hover:-translate-y-0.5 hover:shadow-soft",
        disabled && "cursor-not-allowed opacity-70",
      )}
    >
      {selected && value === "virtual" && (
        <span aria-hidden className="pointer-events-none absolute -inset-1 animate-pulse rounded-2xl bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.18),transparent_65%)]" />
      )}
      <div className="relative flex items-center gap-2">
        <span className={cn("inline-flex h-7 w-7 items-center justify-center rounded-lg ring-1", selected ? iconTone : "bg-surface-inset text-ink-muted ring-border/40")}>
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-ink">{label}</span>
      </div>
      <p className="relative mt-1.5 text-[11px] leading-relaxed text-ink-muted">{caption}</p>
    </button>
  );
}

function WeeklyPresenceStrip({ assignments }: { assignments: AssignmentRow[] }) {
  const resolve = (key: DayKey) => {
    if (assignments.length === 0) return null;
    const pinned = assignments.find((a) => a.daysOfWeek.includes(key));
    if (pinned) return { assignment: pinned, reason: "pin" as const };
    const primary = assignments.find((a) => a.isPrimary);
    if (primary) return { assignment: primary, reason: "primary" as const };
    const any = assignments.find((a) => a.daysOfWeek.length === 0);
    if (any) return { assignment: any, reason: "any" as const };
    return null;
  };
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {DAYS_ORDER.map(({ key, short }) => {
        const r = resolve(key);
        if (!r) {
          return (
            <div key={key} className="rounded-xl border border-dashed border-border bg-surface-inset/20 p-2 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{short}</div>
              <div className="mt-0.5 text-[10.5px] text-ink-subtle">—</div>
            </div>
          );
        }
        const a = r.assignment;
        const swatch = locationSwatch(a.locationId, a.locationType);
        const Icon = locationTypeIcon(a.locationType);
        return (
          <div
            key={key}
            className={cn("rounded-xl border border-border/60 p-2 ring-1 ring-inset", swatch.surface, swatch.ring)}
            title={`${a.locationName} · ${r.reason}`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{short}</span>
              <span className={cn("inline-flex h-3 w-3 items-center justify-center rounded ring-1", swatch.surface, swatch.ring, swatch.text)}>
                <Icon className="h-2 w-2" strokeWidth={1.75} />
              </span>
            </div>
            <div className="mt-1 truncate text-[10.5px] font-semibold text-ink">{a.locationName}</div>
            <div className={cn("mt-0.5 text-[9px] font-semibold uppercase tracking-[0.10em]", swatch.text)}>
              {locationTypeLabel(a.locationType)} · {r.reason}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Sub-primitives (legacy) ─────────────────────────────────

function DayToggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40",
        on ? "bg-brand-accent" : "bg-surface-inset ring-1 ring-border",
        disabled && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.20)] transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          on ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function TimeInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5">
      <Clock className="h-3 w-3 text-ink-subtle" strokeWidth={2} />
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="border-0 bg-transparent p-0 text-[12.5px] tabular-nums text-ink outline-none disabled:opacity-50"
      />
    </span>
  );
}

// ─── Rules ↔ Draft conversion ────────────────────────────────

function rulesToDraft(rules: ScheduleRule[]): Draft {
  const out: Draft = {} as Draft;
  for (const { key } of DAYS_ORDER) {
    out[key] = { open: false, start: "09:00", end: "17:00" };
  }
  for (const r of rules) {
    const key = String(r.dayOfWeek) as DayKey;
    if (key in out) {
      out[key] = { open: true, start: r.startTime, end: r.endTime };
    }
  }
  return out;
}

// Re-export the DayWindow type for downstream consumers.
export type { DayWindow };
