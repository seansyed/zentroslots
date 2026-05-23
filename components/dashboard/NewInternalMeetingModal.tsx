"use client";

/**
 * Phase 17I-2B — Internal Meeting modal.
 *
 * Multi-staff operational meeting (team standup, internal review).
 * NEVER customer-facing. Posts to POST /api/tenant/calendar-events
 * with eventType=internal_meeting.
 *
 * Differences vs the One-on-One Appointment modal:
 *   • Multi-select for attendees (chips + searchable add).
 *   • Provider picker exposes Teams / Google Meet / Zoom. The
 *     orchestrator picks the right calendar host based on the
 *     organizer's connection; Zoom rides as a side-car.
 *   • No customer, no payment, no service.
 *
 * Backend role gate:
 *   • admin / manager  → may set ANY staff as organizer
 *   • staff            → may only set themselves as organizer
 *   • client           → 403 (modal not exposed to them either)
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Building2,
  Calendar,
  Check,
  ChevronDown,
  Loader2,
  MapPin,
  Plus,
  User,
  Users,
  Video,
  X,
} from "lucide-react";

interface StaffLite {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "staff";
}

type VideoProvider = "google_meet" | "teams" | "zoom" | "none";

interface NewInternalMeetingModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (event: { id: string }) => void;
  seedOrganizerId?: string;
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

export default function NewInternalMeetingModal({
  open,
  onClose,
  onCreated,
  seedOrganizerId,
  seedStartAt,
  viewerRole,
  viewerUserId,
}: NewInternalMeetingModalProps) {
  // ── Form state ──────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [organizerId, setOrganizerId] = useState<string>(
    seedOrganizerId ?? (viewerRole === "staff" ? viewerUserId : ""),
  );
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const [attendeeQuery, setAttendeeQuery] = useState("");
  const [startAt, setStartAt] = useState<string>(seedStartAt ?? "");
  const [endAt, setEndAt] = useState<string>("");
  const [videoProvider, setVideoProvider] = useState<VideoProvider>("none");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [sendNotifications, setSendNotifications] = useState(true);
  const [syncExternal, setSyncExternal] = useState(true);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Derived ─────────────────────────────────────────────────
  const organizer = useMemo(
    () => staff.find((s) => s.id === organizerId) ?? null,
    [staff, organizerId],
  );

  const attendees = useMemo(
    () =>
      attendeeIds
        .map((id) => staff.find((s) => s.id === id))
        .filter((u): u is StaffLite => Boolean(u)),
    [attendeeIds, staff],
  );

  // Staff role can only organize their own meetings. Backend enforces;
  // we also restrict the picker for clarity.
  const visibleOrganizers = useMemo(
    () => (viewerRole === "staff" ? staff.filter((s) => s.id === viewerUserId) : staff),
    [staff, viewerRole, viewerUserId],
  );

  // Attendee picker excludes the organizer (already implicit) and
  // anyone already added. Free-text query filters by name/email.
  const attendeeCandidates = useMemo(() => {
    const q = attendeeQuery.trim().toLowerCase();
    return staff
      .filter((s) => s.id !== organizerId && !attendeeIds.includes(s.id))
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.email.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [staff, organizerId, attendeeIds, attendeeQuery]);

  // ── Reset on open ───────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setOrganizerId(seedOrganizerId ?? (viewerRole === "staff" ? viewerUserId : ""));
    setAttendeeIds([]);
    setAttendeeQuery("");
    setStartAt(seedStartAt ?? "");
    setEndAt("");
    setVideoProvider("none");
    setLocation("");
    setNotes("");
    setInternalNotes("");
    setSendNotifications(true);
    setSyncExternal(true);
    setError(null);
    setSubmitting(false);
  }, [open, seedOrganizerId, seedStartAt, viewerRole, viewerUserId]);

  // ── Lazy staff lookup ───────────────────────────────────────
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
        console.warn("[NewInternalMeetingModal] staff load failed:", e);
      }
    })();
  }, [open]);

  // If the organizer changes and was previously also in attendees,
  // drop them — backend strips them too, but the UI should match.
  useEffect(() => {
    if (!organizerId) return;
    setAttendeeIds((prev) => prev.filter((id) => id !== organizerId));
  }, [organizerId]);

  if (!open) return null;

  // ── Submit ──────────────────────────────────────────────────
  async function handleSubmit() {
    setError(null);
    if (!title.trim()) {
      setError("Add a meeting title.");
      return;
    }
    if (!organizerId) {
      setError("Pick an organizer.");
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
      eventType: "internal_meeting" as const,
      title: title.trim(),
      staffUserId: organizerId,
      attendeeUserIds: attendeeIds,
      startAt: startDate.toISOString(),
      endAt: endDate.toISOString(),
      allDay: false,
      notes: notes.trim() || undefined,
      internalNotes: internalNotes.trim() || undefined,
      location: location.trim() || undefined,
      videoProvider: videoProvider === "none" ? undefined : videoProvider,
      sendNotifications,
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
        setError(data?.error ?? "Could not create internal meeting.");
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
      aria-label="New internal meeting"
    >
      <div className="w-full max-w-2xl bg-white sm:rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-screen sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <Building2 className="h-4 w-4" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">New internal meeting</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Calendar-only event for staff. Never customer-facing.
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
              placeholder="e.g. Team standup, Q3 planning"
              maxLength={255}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              autoFocus
            />
          </div>

          {/* Organizer */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Organizer
            </label>
            <div className="relative">
              <select
                value={organizerId}
                onChange={(e) => setOrganizerId(e.target.value)}
                disabled={viewerRole === "staff"}
                className="w-full appearance-none rounded-lg border border-slate-300 pl-3 pr-9 py-2 text-sm bg-white disabled:bg-slate-50"
              >
                <option value="">Choose organizer…</option>
                {visibleOrganizers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.role})
                  </option>
                ))}
              </select>
              <User className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              The meeting lands on the organizer&apos;s connected calendar; video links use their
              account.
              {viewerRole === "staff" && " Staff can only organize their own meetings."}
            </p>
          </div>

          {/* Attendees — chips + searchable add */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Attendees ({attendees.length})
            </label>
            {attendees.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {attendees.map((u) => (
                  <span
                    key={u.id}
                    className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 border border-indigo-200 pl-2.5 pr-1 py-1 text-[12px] font-medium text-indigo-800"
                  >
                    {u.name}
                    <button
                      type="button"
                      onClick={() => setAttendeeIds((ids) => ids.filter((id) => id !== u.id))}
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full hover:bg-indigo-100"
                      aria-label={`Remove ${u.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="relative">
              <Users className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={attendeeQuery}
                onChange={(e) => setAttendeeQuery(e.target.value)}
                placeholder={
                  organizerId
                    ? "Search staff to invite…"
                    : "Pick an organizer first"
                }
                disabled={!organizerId}
                className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm disabled:bg-slate-50"
              />
            </div>
            {organizerId && (attendeeQuery.length > 0 || attendeeCandidates.length > 0) && (
              <ul className="mt-2 rounded-lg border border-slate-200 bg-white max-h-40 overflow-y-auto divide-y divide-slate-100">
                {attendeeCandidates.length === 0 ? (
                  <li className="px-3 py-2 text-xs text-slate-500">No matches.</li>
                ) : (
                  attendeeCandidates.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setAttendeeIds((ids) =>
                            ids.includes(u.id) ? ids : [...ids, u.id],
                          );
                          setAttendeeQuery("");
                        }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900 truncate">
                            {u.name}
                          </div>
                          <div className="text-xs text-slate-500 truncate">{u.email}</div>
                        </div>
                        <Plus className="h-3.5 w-3.5 text-slate-400" />
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
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
              Location (optional)
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

          {/* Notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Agenda / notes
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

          {/* Toggles */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2">
            <ToggleRow
              label="Send attendee notifications"
              hint="Google → email + .ics. Outlook → calendar invite. Off = quietly added to calendars."
              value={sendNotifications}
              onChange={setSendNotifications}
            />
            <ToggleRow
              label="Push to organizer's connected calendar"
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
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Check className="h-3.5 w-3.5" />
            Create meeting
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
