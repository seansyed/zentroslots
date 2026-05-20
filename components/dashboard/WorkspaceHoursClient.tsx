"use client";

import * as React from "react";
import { Calendar, Clock, Copy, Users, Pencil, CheckCircle2 } from "lucide-react";

import { Button, toast } from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import type { DayWindow, DefaultWorkspaceHours } from "@/lib/workspace-hours";

// ─── Workspace Hours editor ────────────────────────────────────────
//
// Premium 7-day weekly schedule editor for tenant-level default
// workspace hours (migration 0034).
//
// What this is NOT:
//   • A per-staff editor. That lives in the StaffClient drawer
//     Schedule tab.
//   • A booking-rules editor. Business-hours envelope used by
//     lib/booking-rules.validateBookingRules is a separate concern.
//
// Resolution chain (lib/availability.ts): per-staff weekly rules
// take precedence over these defaults. So changes here ONLY affect
// staff who haven't configured custom hours — the operational
// counter at the top of the page makes that footprint visible.

const DAYS: { key: keyof DefaultWorkspaceHours; label: string }[] = [
  { key: "1", label: "Monday" },
  { key: "2", label: "Tuesday" },
  { key: "3", label: "Wednesday" },
  { key: "4", label: "Thursday" },
  { key: "5", label: "Friday" },
  { key: "6", label: "Saturday" },
  { key: "0", label: "Sunday" },
];

type DraftDay = { open: boolean; start: string; end: string };
type Draft = Record<keyof DefaultWorkspaceHours, DraftDay>;

function makeDraft(hours: DefaultWorkspaceHours): Draft {
  const out = {} as Draft;
  for (const { key } of DAYS) {
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
  for (const { key } of DAYS) {
    const day = d[key];
    out[key] = day.open ? { start: day.start, end: day.end } : null;
  }
  return out;
}

function hoursEqual(a: Draft, b: Draft): boolean {
  for (const { key } of DAYS) {
    if (a[key].open !== b[key].open) return false;
    if (a[key].open) {
      if (a[key].start !== b[key].start) return false;
      if (a[key].end !== b[key].end) return false;
    }
  }
  return true;
}

export default function WorkspaceHoursClient({
  initial,
  canEdit,
  initialInheritingCount,
  workforceCount,
}: {
  initial: DefaultWorkspaceHours;
  canEdit: boolean;
  initialInheritingCount: number;
  workforceCount: number;
}) {
  const [draft, setDraft] = React.useState<Draft>(() => makeDraft(initial));
  const [baseline, setBaseline] = React.useState<Draft>(() => makeDraft(initial));
  const [saving, setSaving] = React.useState(false);
  const [inheritingCount, setInheritingCount] = React.useState(initialInheritingCount);

  const dirty = !hoursEqual(draft, baseline);
  const openDays = DAYS.filter(({ key }) => draft[key].open).length;
  const hasAny = openDays > 0;

  function toggleDay(key: keyof DefaultWorkspaceHours, on: boolean) {
    setDraft((d) => ({ ...d, [key]: { ...d[key], open: on } }));
  }

  function setTime(
    key: keyof DefaultWorkspaceHours,
    field: "start" | "end",
    value: string,
  ) {
    setDraft((d) => ({ ...d, [key]: { ...d[key], [field]: value } }));
  }

  function copyToWeekdays() {
    // Source: Monday's draft (open or closed — we copy the times
    // either way; the open flag carries separately).
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
      for (const { key } of DAYS) next[key] = { ...mon };
      return next;
    });
  }

  function reset() {
    setDraft(baseline);
  }

  async function save() {
    if (!canEdit || !dirty) return;
    // Validate start < end on open days.
    for (const { key, label } of DAYS) {
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
      // Refresh inheriting count — the # of staff inheriting can
      // change implicitly if workspace hours go from {} → populated.
      try {
        const r = await fetch("/api/tenant/workspace-hours");
        if (r.ok) {
          const d2 = await r.json();
          if (typeof d2?.inheritingStaffCount === "number") {
            setInheritingCount(d2.inheritingStaffCount);
          }
        }
      } catch {
        // ignore — counter is best-effort
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5 pb-24">
      {/* Hero — operational intelligence */}
      <PremiumCard className="relative overflow-hidden p-5">
        <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Workspace defaults
            </div>
            <h1 className="mt-0.5 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
              Default workspace hours
            </h1>
            <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-ink-muted">
              The fallback weekly schedule every workforce member inherits when they
              haven&rsquo;t configured custom hours. Staff with their own schedule are
              never overwritten — this layer is fallback-only.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <InheritingChip
              inheritingCount={inheritingCount}
              workforceCount={workforceCount}
            />
            <CoverageChip openDays={openDays} hasAny={hasAny} />
          </div>
        </div>
      </PremiumCard>

      {/* Day editor */}
      <PremiumCard className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Weekly schedule
            </div>
            <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
              Open hours by day
            </h2>
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
          {DAYS.map(({ key, label }) => {
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
                <div className="w-24 shrink-0 text-[13px] font-medium text-ink">
                  {label}
                </div>
                {day.open ? (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <TimeInput
                      value={day.start}
                      onChange={(v) => setTime(key, "start", v)}
                      disabled={!canEdit || saving}
                    />
                    <span className="text-[12px] text-ink-subtle">–</span>
                    <TimeInput
                      value={day.end}
                      onChange={(v) => setTime(key, "end", v)}
                      disabled={!canEdit || saving}
                    />
                  </div>
                ) : (
                  <div className="flex-1 text-[11.5px] uppercase tracking-[0.10em] text-ink-subtle">
                    Closed
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </PremiumCard>

      {/* Inheritance preview — calm context */}
      {hasAny && (
        <PremiumCard className="p-4">
          <div className="flex items-start gap-3">
            <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15">
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div>
              <div className="text-[12.5px] font-semibold tracking-tight text-ink">
                Inheritance behavior
              </div>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">
                Staff with no rows in their own weekly schedule inherit these hours.
                Per-staff overrides — when present — always win over this fallback.
                Per-date overrides (vacations, custom days) continue to apply on top.
              </p>
            </div>
          </div>
        </PremiumCard>
      )}

      {/* Save bar */}
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
    </div>
  );
}

// ─── Sub-primitives ───────────────────────────────────────────────

function InheritingChip({
  inheritingCount,
  workforceCount,
}: {
  inheritingCount: number;
  workforceCount: number;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/80 px-2.5 py-1 text-[11px] font-medium text-ink-muted shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <Users className="h-3 w-3 text-brand-accent" strokeWidth={2} />
      <span className="tabular-nums">
        <span className="font-semibold text-ink">{inheritingCount}</span>
        <span className="text-ink-subtle"> / {workforceCount}</span>
      </span>
      <span>staff inherit</span>
    </span>
  );
}

function CoverageChip({ openDays, hasAny }: { openDays: number; hasAny: boolean }) {
  if (!hasAny) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50/80 px-2.5 py-1 text-[11px] font-semibold text-amber-800 ring-1 ring-amber-200/40">
        <Calendar className="h-3 w-3" strokeWidth={2} />
        No fallback configured
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50/80 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-300/40">
      <Calendar className="h-3 w-3" strokeWidth={2} />
      {openDays} day{openDays === 1 ? "" : "s"} open
    </span>
  );
}

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

// Re-export the DayWindow type for downstream consumers that import
// from this file specifically. Kept here so the editor and the
// canonical schema stay aligned.
export type { DayWindow };
