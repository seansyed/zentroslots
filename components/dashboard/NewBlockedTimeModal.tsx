"use client";

/**
 * Phase 17I-2B — Blocked Time modal.
 *
 * Operational modal for marking a single staff member's slot
 * unavailable (lunch, PTO, focus, tax-season). NEVER customer-facing.
 *
 * Posts to POST /api/tenant/calendar-events with eventType=blocked_time.
 * Backend enforces:
 *   • admin / manager → may block ANY staff
 *   • staff           → may only block themselves
 *   • bookings_no_overlap-style EXCLUDE constraint on the
 *     calendar_events table is the hard backstop against two
 *     overlapping blocks on the same staff slot.
 *
 * Mirrors NewAppointmentModal's UX patterns:
 *   • createPortal(... , document.body) escape from the topbar's
 *     backdrop-filter containing block.
 *   • Optimistic field rendering — service / staff / customer
 *     lookups are lazy; the picker stays usable while results load.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Ban,
  Calendar,
  Check,
  ChevronDown,
  Loader2,
  User,
  X,
} from "lucide-react";

interface StaffLite {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "staff";
}

interface NewBlockedTimeModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (event: { id: string }) => void;
  seedStaffUserId?: string;
  seedStartAt?: string; // ISO
  viewerRole: "admin" | "manager" | "staff" | "client";
  viewerUserId: string;
}

const BLOCK_TEMPLATES = [
  "Lunch",
  "Focus block",
  "PTO",
  "Out of office",
  "Tax-season block",
  "Personal",
];

export default function NewBlockedTimeModal({
  open,
  onClose,
  onCreated,
  seedStaffUserId,
  seedStartAt,
  viewerRole,
  viewerUserId,
}: NewBlockedTimeModalProps) {
  // Form state
  const [title, setTitle] = useState("");
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [staffUserId, setStaffUserId] = useState<string>(seedStaffUserId ?? "");
  const [startAt, setStartAt] = useState<string>(seedStartAt ?? "");
  const [endAt, setEndAt] = useState<string>("");
  const [allDay, setAllDay] = useState(false);
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [syncExternal, setSyncExternal] = useState(true);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Staff role can only block themselves. Backend enforces; we
  // collapse the picker to a single self-row for clarity.
  const visibleStaff =
    viewerRole === "staff" ? staff.filter((s) => s.id === viewerUserId) : staff;

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setStaffUserId(seedStaffUserId ?? (viewerRole === "staff" ? viewerUserId : ""));
    setStartAt(seedStartAt ?? "");
    setEndAt("");
    setAllDay(false);
    setNotes("");
    setInternalNotes("");
    setSyncExternal(true);
    setError(null);
    setSubmitting(false);
  }, [open, seedStaffUserId, seedStartAt, viewerRole, viewerUserId]);

  // Lazy-load staff once on open
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const res = await fetch("/api/staff", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const list: StaffLite[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.staff)
          ? data.staff
          : [];
        setStaff(
          list.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            role: u.role,
          })),
        );
      } catch (e) {
        console.warn("[NewBlockedTimeModal] staff load failed:", e);
      }
    })();
  }, [open]);

  // When the user toggles all-day on, snap start/end to date-only
  // boundaries (start of day → start of next day). The route still
  // stores ISO datetimes; the all_day flag is a presentation hint.
  useEffect(() => {
    if (!allDay) return;
    if (!startAt) return;
    const d = new Date(startAt);
    if (Number.isNaN(d.getTime())) return;
    const startOfDay = new Date(d);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(endOfDay.getDate() + 1);
    setStartAt(toLocalInput(startOfDay));
    setEndAt(toLocalInput(endOfDay));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDay]);

  if (!open) return null;

  async function handleSubmit() {
    setError(null);
    if (!title.trim()) {
      setError("Add a title (e.g. Lunch, PTO).");
      return;
    }
    if (!staffUserId) {
      setError("Pick a staff member to block.");
      return;
    }
    if (!startAt || !endAt) {
      setError("Pick a start and end time.");
      return;
    }
    const startDate = new Date(startAt);
    const endDate = new Date(endAt);
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      setError("Invalid date/time.");
      return;
    }
    if (endDate.getTime() <= startDate.getTime()) {
      setError("End must be after start.");
      return;
    }

    const payload = {
      eventType: "blocked_time" as const,
      title: title.trim(),
      staffUserId,
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      allDay,
      notes: notes.trim() || undefined,
      internalNotes: internalNotes.trim() || undefined,
      syncExternal,
    };

    setSubmitting(true);
    try {
      const res = await fetch("/api/tenant/calendar-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not create blocked time.");
        setSubmitting(false);
        return;
      }
      onCreated?.(data);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setSubmitting(false);
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-stretch sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Block time"
    >
      <div className="w-full max-w-xl bg-white sm:rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-screen sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
              <Ban className="h-4 w-4" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Block time</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Mark a slot unavailable. No customer, no notifications.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Title + templates */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Lunch, PTO, Focus"
              maxLength={255}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              autoFocus
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {BLOCK_TEMPLATES.map((tpl) => (
                <button
                  key={tpl}
                  type="button"
                  onClick={() => setTitle(tpl)}
                  className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100 hover:border-slate-300"
                >
                  {tpl}
                </button>
              ))}
            </div>
          </div>

          {/* Staff */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Whose calendar
            </label>
            <div className="relative">
              <select
                value={staffUserId}
                onChange={(e) => setStaffUserId(e.target.value)}
                disabled={viewerRole === "staff"}
                className="w-full appearance-none rounded-lg border border-slate-300 pl-3 pr-9 py-2 text-sm bg-white disabled:bg-slate-50"
              >
                <option value="">Choose staff…</option>
                {visibleStaff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.role})
                  </option>
                ))}
              </select>
              <User className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
            {viewerRole === "staff" && (
              <p className="mt-1 text-[11px] text-slate-500">
                Staff can only block their own calendar.
              </p>
            )}
          </div>

          {/* All-day toggle */}
          <ToggleRow
            label="All day"
            hint="Snaps start/end to a full calendar day."
            value={allDay}
            onChange={setAllDay}
          />

          {/* Start / End */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
                Start
              </label>
              <div className="relative">
                <input
                  type="datetime-local"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 pl-3 pr-9 py-2 text-sm"
                />
                <Calendar className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
                End
              </label>
              <div className="relative">
                <input
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 pl-3 pr-9 py-2 text-sm"
                />
                <Calendar className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              </div>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Notes (optional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Goes on the calendar entry."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none"
            />
          </div>

          {/* Internal notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Internal notes (staff only)
            </label>
            <textarea
              value={internalNotes}
              onChange={(e) => setInternalNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Visible only on the dashboard."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none"
            />
          </div>

          {/* Sync toggle */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <ToggleRow
              label="Push to connected calendar"
              hint="Outlook / Google block appears for the staff member. Turn off for ZentroMeet-only blocks."
              value={syncExternal}
              onChange={setSyncExternal}
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span className="flex-1">{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss">
                <X className="h-4 w-4 text-red-600" />
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-4 bg-slate-50/50 sm:rounded-b-2xl">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Check className="h-3.5 w-3.5" />
            Block this slot
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`mt-0.5 relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
          value ? "bg-emerald-500" : "bg-slate-300"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            value ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {hint && <span className="block text-[11px] text-slate-500 mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

/** datetime-local needs YYYY-MM-DDTHH:mm with no Z/timezone suffix.
 *  We pad each part so a Date instance round-trips into the input. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}
