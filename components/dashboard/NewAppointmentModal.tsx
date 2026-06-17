"use client";

/**
 * Phase 17H — admin/staff "New Appointment" modal.
 *
 * Operational counterpart to the public booking flow. Reachable from:
 *   • Top-bar "Create" dropdown ("One-on-One Appointment")
 *   • /dashboard/appointments page header
 *   • /dashboard/calendar page header
 *
 * Posts to POST /api/tenant/appointments (Phase 1 endpoint). The
 * endpoint enforces all role gating + tenant scoping; this modal is
 * purely a UX wrapper.
 *
 * Single-modal architecture — every call site uses the same component
 * via the `open / onClose / onCreated` contract. The orchestrator
 * runs fire-and-forget on the server so this modal resolves in
 * ~300ms regardless of calendar-provider latency.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { friendlyMessage, friendlyThrown } from "@/lib/clientErrors";
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronDown,
  Loader2,
  Search,
  User,
  X,
} from "lucide-react";

interface CustomerLite {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
}

interface ServiceLite {
  id: string;
  name: string;
  durationMinutes: number;
  price: number;
  videoProvider: string | null;
}

interface StaffLite {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "staff";
}

interface NewAppointmentModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (booking: { id: string }) => void;
  /** Optional pre-fill — e.g. opening from a customer drawer can
   *  seed the customer; opening from a staff drawer can seed the
   *  staff member. */
  seedCustomerId?: string;
  seedStaffUserId?: string;
  seedStartAt?: string; // ISO
  /** Viewer's role + id — drives the staff picker scope (staff role
   *  may only book for themselves in v1). */
  viewerRole: "admin" | "manager" | "staff" | "client";
  viewerUserId: string;
}

export default function NewAppointmentModal({
  open,
  onClose,
  onCreated,
  seedCustomerId,
  seedStaffUserId,
  seedStartAt,
  viewerRole,
  viewerUserId,
}: NewAppointmentModalProps) {
  // ── Form state ──────────────────────────────────────────────
  // Customer: either pick an existing one OR quick-create. The two
  // states are mutually exclusive at submit time (the zod schema on
  // the server enforces it too).
  const [customerMode, setCustomerMode] = useState<"select" | "create">("select");
  const [customerId, setCustomerId] = useState<string | null>(seedCustomerId ?? null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerLite[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [pickedCustomer, setPickedCustomer] = useState<CustomerLite | null>(null);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  // Service / staff / time
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [serviceId, setServiceId] = useState<string>("");
  const [staff, setStaff] = useState<StaffLite[]>([]);
  const [staffUserId, setStaffUserId] = useState<string>(seedStaffUserId ?? "");
  const [startAt, setStartAt] = useState<string>(seedStartAt ?? "");

  // Notes + toggles
  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [skipPayment, setSkipPayment] = useState(false);
  const [forceBook, setForceBook] = useState(false);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedService = useMemo(
    () => services.find((s) => s.id === serviceId) ?? null,
    [services, serviceId],
  );

  // Staff role restriction. Backend also enforces this; we hide the
  // option here for clarity. Staff role sees ONLY their own user in
  // the staff dropdown.
  const visibleStaff = useMemo(() => {
    if (viewerRole === "staff") {
      return staff.filter((s) => s.id === viewerUserId);
    }
    return staff;
  }, [staff, viewerRole, viewerUserId]);

  // ── Reset on open / close ───────────────────────────────────
  useEffect(() => {
    if (!open) return;
    // Re-seed every time the modal opens so consecutive opens from
    // different surfaces (customer drawer → calendar) start clean.
    setCustomerMode("select");
    setCustomerId(seedCustomerId ?? null);
    setCustomerQuery("");
    setCustomerResults([]);
    setPickedCustomer(null);
    setNewCustomerName("");
    setNewCustomerEmail("");
    setNewCustomerPhone("");
    setServiceId("");
    setStaffUserId(seedStaffUserId ?? (viewerRole === "staff" ? viewerUserId : ""));
    setStartAt(seedStartAt ?? "");
    setNotes("");
    setInternalNotes("");
    setSendConfirmation(true);
    setSkipPayment(false);
    setForceBook(false);
    setError(null);
    setSubmitting(false);
  }, [open, seedCustomerId, seedStaffUserId, seedStartAt, viewerRole, viewerUserId]);

  // ── Service + staff lookup on open ──────────────────────────
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
          // /api/services returns an array of services with staff[]
          // — we only need the service-level fields for this picker.
          setServices(
            (Array.isArray(sData) ? sData : []).map((s: ServiceLite) => ({
              id: s.id,
              name: s.name,
              durationMinutes: s.durationMinutes,
              price: s.price,
              videoProvider: s.videoProvider,
            })),
          );
        }
        if (stRes.ok) {
          const stData = await stRes.json();
          // /api/staff returns a raw array (admin/manager/staff rows
          // for this tenant, with stats appended). Defensively accept
          // a wrapped { staff: [...] } shape too in case a future
          // refactor changes the contract — both forms become the
          // same StaffLite[] for the picker.
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
        console.warn("[NewAppointmentModal] load failed:", e);
      }
    })();
  }, [open]);

  // ── Customer search (debounced) ─────────────────────────────
  useEffect(() => {
    if (customerMode !== "select" || !customerQuery.trim() || customerQuery.length < 2) {
      setCustomerResults([]);
      return;
    }
    const t = setTimeout(() => {
      void (async () => {
        setCustomerLoading(true);
        try {
          const res = await fetch(
            `/api/customers?q=${encodeURIComponent(customerQuery.trim())}&limit=8`,
            { cache: "no-store" },
          );
          if (res.ok) {
            const data = await res.json();
            // /api/customers returns { customers: [...] } or an array
            // depending on shape — handle both for defensive parsing.
            const list: CustomerLite[] = Array.isArray(data) ? data : data.customers ?? [];
            setCustomerResults(list.slice(0, 8));
          }
        } catch {
          /* swallow — empty results is fine */
        } finally {
          setCustomerLoading(false);
        }
      })();
    }, 220);
    return () => clearTimeout(t);
  }, [customerQuery, customerMode]);

  if (!open) return null;

  // ── Submit ──────────────────────────────────────────────────
  async function handleSubmit() {
    setError(null);
    // Client-side guard rails — server re-validates everything.
    if (!serviceId) {
      setError("Pick a service");
      return;
    }
    if (!staffUserId) {
      setError("Pick a staff member");
      return;
    }
    if (!startAt) {
      setError("Pick a start time");
      return;
    }
    if (customerMode === "select" && !customerId) {
      setError("Pick or create a customer");
      return;
    }
    if (customerMode === "create" && (!newCustomerName.trim() || !newCustomerEmail.trim())) {
      setError("New customer needs a name and email");
      return;
    }
    if (selectedService && selectedService.price > 0 && !skipPayment) {
      setError(
        "This is a paid service. Toggle 'Skip payment' to admin-book without charging the customer.",
      );
      return;
    }

    // Send the NAIVE wall-clock ("2026-06-20T15:00") as `startLocal`. The
    // server interprets it in the BUSINESS timezone — so the booking means
    // that clock time at the business regardless of this browser's tz.
    // (Previously we did new Date(startAt).toISOString(), which baked in the
    // operator's BROWSER tz — wrong for a cross-tz operator.)
    const payload =
      customerMode === "select"
        ? {
            customerId,
            serviceId,
            staffUserId,
            startLocal: startAt,
            notes: notes.trim() || undefined,
            internalNotes: internalNotes.trim() || undefined,
            sendConfirmation,
            skipPayment,
            forceBook,
          }
        : {
            customer: {
              name: newCustomerName.trim(),
              email: newCustomerEmail.trim(),
              phone: newCustomerPhone.trim() || undefined,
            },
            serviceId,
            staffUserId,
            startLocal: startAt,
            notes: notes.trim() || undefined,
            internalNotes: internalNotes.trim() || undefined,
            sendConfirmation,
            skipPayment,
            forceBook,
          };

    setSubmitting(true);
    try {
      const res = await fetch("/api/tenant/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Never echo a raw server error. 4xx carry safe, operator-authored
        // messages (e.g. "Staff does not deliver this service"); unexpected
        // 5xx get friendly create-specific copy. See lib/clientErrors.ts.
        setError(
          friendlyMessage(res.status, data, {
            genericMessage:
              "Something went wrong while creating the appointment. Please try again.",
          }),
        );
        setSubmitting(false);
        return;
      }
      // Surface success + close. Parent decides whether to refresh.
      onCreated?.(data);
      onClose();
    } catch {
      // A thrown fetch = no structured response (almost always connectivity).
      setError(friendlyThrown().message);
      setSubmitting(false);
    }
  }

  // ── Portal to document.body ─────────────────────────────────
  // The modal is mounted inside the Topbar, which has
  // `backdrop-blur-2xl`. `backdrop-filter` creates a new containing
  // block for `position: fixed` descendants, which collapses the
  // modal's intended viewport-sized overlay down to the 64px-tall
  // topbar. Rendering through a portal to `document.body` escapes
  // that containing block and restores true viewport positioning.
  // SSR-safe: createPortal is only called after the first client
  // render, and Next.js client components render on the client.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-stretch sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New appointment"
    >
      <div className="w-full max-w-xl bg-white sm:rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-screen sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">New appointment</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Book a customer directly. Bypasses the public booking flow and intake forms.
            </p>
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
          {/* Customer */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-700">
                Customer
              </label>
              <button
                type="button"
                onClick={() =>
                  setCustomerMode((m) => (m === "select" ? "create" : "select"))
                }
                className="text-xs text-blue-700 hover:text-blue-900"
              >
                {customerMode === "select" ? "+ New customer" : "← Pick existing"}
              </button>
            </div>

            {customerMode === "select" ? (
              <div className="space-y-2">
                {pickedCustomer ? (
                  <div className="flex items-center justify-between rounded-lg border border-slate-300 bg-slate-50 px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">
                        {pickedCustomer.name}
                      </div>
                      <div className="text-xs text-slate-600 truncate">
                        {pickedCustomer.email}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setPickedCustomer(null);
                        setCustomerId(null);
                        setCustomerQuery("");
                      }}
                      className="text-xs text-slate-500 hover:text-slate-900"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                      <input
                        type="text"
                        value={customerQuery}
                        onChange={(e) => setCustomerQuery(e.target.value)}
                        placeholder="Search by name or email…"
                        className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
                        autoFocus
                      />
                      {customerLoading && (
                        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-slate-400" />
                      )}
                    </div>
                    {customerResults.length > 0 && (
                      <ul className="rounded-lg border border-slate-200 bg-white max-h-48 overflow-y-auto divide-y divide-slate-100">
                        {customerResults.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => {
                                setPickedCustomer(c);
                                setCustomerId(c.id);
                              }}
                              className="w-full text-left px-3 py-2 hover:bg-slate-50"
                            >
                              <div className="text-sm font-medium text-slate-900">{c.name}</div>
                              <div className="text-xs text-slate-500">{c.email}</div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {customerQuery.length >= 2 &&
                      !customerLoading &&
                      customerResults.length === 0 && (
                        <div className="text-xs text-slate-500 px-1">
                          No matches. Click <strong>+ New customer</strong> above to create one.
                        </div>
                      )}
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                <input
                  type="text"
                  value={newCustomerName}
                  onChange={(e) => setNewCustomerName(e.target.value)}
                  placeholder="Full name"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  autoFocus
                />
                <input
                  type="email"
                  value={newCustomerEmail}
                  onChange={(e) => setNewCustomerEmail(e.target.value)}
                  placeholder="Email"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
                <input
                  type="tel"
                  value={newCustomerPhone}
                  onChange={(e) => setNewCustomerPhone(e.target.value)}
                  placeholder="Phone (optional)"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            )}
          </div>

          {/* Service */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Service
            </label>
            <div className="relative">
              <select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                className="w-full appearance-none rounded-lg border border-slate-300 pl-3 pr-9 py-2 text-sm bg-white"
              >
                <option value="">Choose a service…</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.durationMinutes} min
                    {s.price > 0 ? ` · $${(s.price / 100).toFixed(2)}` : " · free"}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            </div>
            {selectedService && selectedService.price > 0 && (
              <p className="mt-1 text-[11px] text-amber-700">
                Paid service ({(selectedService.price / 100).toFixed(2)}). Toggle &quot;Skip
                payment&quot; below to admin-book without charging.
              </p>
            )}
          </div>

          {/* Staff */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Staff
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
                Staff can only create appointments assigned to themselves.
              </p>
            )}
          </div>

          {/* Start time */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Start time
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

          {/* Notes */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700 mb-1.5">
              Notes (visible to customer)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Optional. Goes into the confirmation email."
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
              placeholder="Optional. Visible only on the dashboard."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm resize-none"
            />
          </div>

          {/* Toggles */}
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2">
            <ToggleRow
              label="Send confirmation email"
              hint="Standard confirmation + .ics attachment. Turn off for silent admin entry."
              value={sendConfirmation}
              onChange={setSendConfirmation}
            />
            <ToggleRow
              label="Skip payment"
              hint="Required to book a paid service without routing to Stripe."
              value={skipPayment}
              onChange={setSkipPayment}
            />
            <ToggleRow
              label="Force book despite conflict"
              hint="Bypass the soft overlap warning. DB constraint still rejects true double-books."
              value={forceBook}
              onChange={setForceBook}
            />
          </div>

          {/* Error */}
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
            Create appointment
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
