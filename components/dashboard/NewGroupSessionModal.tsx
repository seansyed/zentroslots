"use client";

/**
 * Phase 17I-3A — Group Session modal.
 *
 * Customer-facing group event: one host + many attendees + one shared
 * meeting link (webinars, onboarding, workshops, office hours). Posts
 * to POST /api/tenant/group-sessions.
 *
 * Differences vs the One-on-One Appointment modal:
 *   • No customer picker (attendees register later via public flow).
 *   • Capacity field (0 = unlimited).
 *   • Optional registration deadline.
 *   • Service is OPTIONAL (ad-hoc office hours allowed).
 *
 * Backend enforces:
 *   • admin / manager → may host ANY staff
 *   • staff           → may only host themselves
 *   • bookings_no_overlap + calendar_events_no_overlap +
 *     group_sessions_no_host_overlap together prevent the host from
 *     being double-booked across any of the three scheduling tables.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  Loader2,
  MapPin,
  User,
  Users,
  Video,
  X,
} from "lucide-react";

interface ServiceLite {
  id: string;
  name: string;
  durationMinutes: number;
}

interface StaffLite {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "staff";
}

type VideoProvider = "google_meet" | "teams" | "zoom" | "none";

interface NewGroupSessionModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (session: { id: string }) => void;
  seedHostUserId?: string;
  seedStartAt?: string;
  viewerRole: "admin" | "manager" | "staff" | "client";
  viewerUserId: string;
}

const VIDEO_OPTIONS: { value: VideoProvider; label: string; hint: string }[] = [
  { value: "none", label: "No video", hint: "Calendar entry only" },
  { value: "google_meet", label: "Google Meet", hint: "Requires Google Calendar connection" },
  { value: "teams", label: "Microsoft Teams", hint: "Requires Outlook connection" },
  { value: "zoom", label: "Zoom", hint: "Requires Zoom connection (side-car meeting)" },
];

export default function NewGroupSessionModal({
  open,
  onClose,
  onCreated,
  seedHostUserId,
  seedStartAt,
  viewerRole,
  viewerUserId,
}: NewGroupSessionModalProps) {
  // ── Form state ──────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [serviceId, setServiceId] = useState<string>("");
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [hostUserId, setHostUserId] = useState<string>(
    seedHostUserId ?? (viewerRole === "staff" ? viewerUserId : ""),
  );
  const [startAt, setStartAt] = useState<string>(seedStartAt ?? "");
  const [endAt, setEndAt] = useState<string>("");
  const [maxCapacity, setMaxCapacity] = useState<string>("0");
  const [videoProvider, setVideoProvider] = useState<VideoProvider>("none");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [registrationDeadline, setRegistrationDeadline] = useState("");
  const [syncExternal, setSyncExternal] = useState(true);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Staff role can only host their own sessions.
  const visibleHosts =
    viewerRole === "staff" ? staff.filter((s) => s.id === viewerUserId) : staff;

  // ── Reset on open ───────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setServiceId("");
    setHostUserId(seedHostUserId ?? (viewerRole === "staff" ? viewerUserId : ""));
    setStartAt(seedStartAt ?? "");
    setEndAt("");
    setMaxCapacity("0");
    setVideoProvider("none");
    setLocation("");
    setNotes("");
    setInternalNotes("");
    setRegistrationDeadline("");
    setSyncExternal(true);
    setError(null);
    setSubmitting(false);
  }, [open, seedHostUserId, seedStartAt, viewerRole, viewerUserId]);

  // ── Lazy lookups ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const [sRes, stRes] = await Promise.all([
          fetch("/api/services", { cache: "no-store" }),
          fetch("/api/staff", { cache: "no-store" }),
        ]);
        if (sRes.ok) {
          const sData = await sRes.json();
          const list = Array.isArray(sData) ? sData : [];
          setServices(
            list.map((s: ServiceLite) => ({
              id: s.id,
              name: s.name,
              durationMinutes: s.durationMinutes,
            })),
          );
        }
        if (stRes.ok) {
          const stData = await stRes.json();
          const list: StaffLite[] = Array.isArray(stData)
            ? stData
            : Array.isArray(stData?.staff)
            ? stData.staff
            : [];
          setStaff(
            list.map((u) => ({
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
            })),
          );
        }
      } catch (e) {
        console.warn("[NewGroupSessionModal] load failed:", e);
      }
    })();
  }, [open]);

  // When the user picks a service, auto-suggest end time = start +
  // service duration if end is empty. Only fires on a fresh service
  // pick — never overrides an end the user already set.
  useEffect(() => {
    if (!serviceId || !startAt || endAt) return;
    const s = services.find((x) => x.id === serviceId);
    if (!s) return;
    const d = new Date(startAt);
    if (Number.isNaN(d.getTime())) return;
    const end = new Date(d.getTime() + s.durationMinutes * 60_000);
    setEndAt(toLocalInput(end));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  if (!open) return null;

  async function handleSubmit() {
    setError(null);
    if (!title.trim()) {
      setError("Add a session title.");
      return;
    }
    if (!hostUserId) {
      setError("Pick a host.");
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
    const cap = parseInt(maxCapacity, 10);
    if (Number.isNaN(cap) || cap < 0) {
      setError("Max capacity must be 0 (unlimited) or a positive number.");
      return;
    }
    let deadlineIso: string | undefined;
    if (registrationDeadline) {
      const rd = new Date(registrationDeadline);
      if (Number.isNaN(rd.getTime())) {
        setError("Invalid registration deadline.");
        return;
      }
      if (rd.getTime() > startDate.getTime()) {
        setError("Registration deadline must be before the session starts.");
        return;
      }
      deadlineIso = rd.toISOString();
    }

    const payload = {
      title: title.trim(),
      serviceId: serviceId || undefined,
      hostUserId,
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      maxCapacity: cap,
      videoProvider: videoProvider === "none" ? undefined : videoProvider,
      location: location.trim() || undefined,
      notes: notes.trim() || undefined,
      internalNotes: internalNotes.trim() || undefined,
      registrationDeadline: deadlineIso,
      syncExternal,
    };

    setSubmitting(true);
    try {
      const res = await fetch("/api/tenant/group-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not create group session.");
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
      aria-label="New group session"
    >
      <div className="w-full max-w-2xl bg-white sm:rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-screen sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
              <Users className="h-4 w-4" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">New group session</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                One host · many attendees · one shared meeting link.
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
          {/* Title */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q2 Onboarding, Tax-season workshop, Office hours"
              maxLength={255}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              autoFocus
            />
          </div>

          {/* Service (optional) */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Service <span className="text-slate-400 normal-case">(optional)</span>
            </label>
            <div className="relative">
              <select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                className="w-full appearance-none rounded-lg border border-slate-300 pl-3 pr-9 py-2 text-sm bg-white"
              >
                <option value="">No service link (ad-hoc)</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.durationMinutes} min
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Pick a service to auto-set the duration, or leave blank for an ad-hoc session.
            </p>
          </div>

          {/* Host */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Host
            </label>
            <div className="relative">
              <select
                value={hostUserId}
                onChange={(e) => setHostUserId(e.target.value)}
                disabled={viewerRole === "staff"}
                className="w-full appearance-none rounded-lg border border-slate-300 pl-3 pr-9 py-2 text-sm bg-white disabled:bg-slate-50"
              >
                <option value="">Choose host…</option>
                {visibleHosts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.role})
                  </option>
                ))}
              </select>
              <User className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              The session sits on the host&apos;s connected calendar; video links use their account.
              {viewerRole === "staff" && " Staff can only host their own sessions."}
            </p>
          </div>

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

          {/* Capacity */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Max capacity
            </label>
            <div className="relative">
              <input
                type="number"
                value={maxCapacity}
                onChange={(e) => setMaxCapacity(e.target.value)}
                min={0}
                max={10000}
                placeholder="0 = unlimited"
                className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
              <Users className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              0 means no cap. Once the public registration flow ships, capacity is enforced
              automatically.
            </p>
          </div>

          {/* Video provider */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Video conference
            </label>
            <div className="relative">
              <select
                value={videoProvider}
                onChange={(e) => setVideoProvider(e.target.value as VideoProvider)}
                className="w-full appearance-none rounded-lg border border-slate-300 pl-3 pr-9 py-2 text-sm bg-white"
              >
                {VIDEO_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <Video className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              {VIDEO_OPTIONS.find((o) => o.value === videoProvider)?.hint}
            </p>
          </div>

          {/* Location */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Location <span className="text-slate-400 normal-case">(optional)</span>
            </label>
            <div className="relative">
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Room 3B, HQ, or a physical address"
                maxLength={500}
                className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
              <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
          </div>

          {/* Registration deadline */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Registration deadline <span className="text-slate-400 normal-case">(optional)</span>
            </label>
            <div className="relative">
              <input
                type="datetime-local"
                value={registrationDeadline}
                onChange={(e) => setRegistrationDeadline(e.target.value)}
                className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
              />
              <Clock className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Stored now; enforced when public registration ships.
            </p>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Description / agenda
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="What the session covers. Shown on the calendar entry."
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

          {/* Toggles */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <ToggleRow
              label="Push to host's connected calendar"
              hint="Required for Teams / Meet / Zoom links to work. Off = ZentroMeet calendar only."
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
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Check className="h-3.5 w-3.5" />
            Create session
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
