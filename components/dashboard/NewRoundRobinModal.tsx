"use client";

/**
 * Phase 17I-4A — Round Robin appointment modal.
 *
 * Variant of NewAppointmentModal where staff is auto-assigned via the
 * existing routing engine instead of the operator picking explicitly.
 *
 * Architecture — REUSE, no new routing logic:
 *   • Calls POST /api/tenant/routing/simulate (Phase 15 — admin
 *     what-if console) to preview which staff the routing engine
 *     would pick for (service, startAt). Returns ok/staffId/mode/
 *     reason without writing anything.
 *   • Displays the preview to the operator BEFORE submit so they can
 *     see who routing chose.
 *   • Submits to POST /api/tenant/appointments with the picked
 *     staffId — same endpoint the One-on-One modal uses. Zero new
 *     booking-creation logic.
 *
 * Routing modes honored (whatever the tenant has configured):
 *   round_robin | least_busy | priority | weighted | manual → 403
 *   No-op for the modal — when no routing rule applies the simulate
 *   call returns ok:false with a reason and we surface it as an
 *   error message ("Configure routing under Settings → Staff Routing
 *   to use auto-assign").
 *
 * Strict-safe-mode receipts:
 *   • Routing engine in lib/routing/* — UNCHANGED.
 *   • /api/tenant/routing/simulate endpoint — UNCHANGED.
 *   • /api/tenant/appointments endpoint — UNCHANGED.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Calendar,
  Check,
  ChevronDown,
  Loader2,
  Repeat,
  Search,
  Shuffle,
  Sparkles,
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

interface NewRoundRobinModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (booking: { id: string }) => void;
  viewerRole: "admin" | "manager" | "staff" | "client";
  viewerUserId: string;
}

type RoutingPreview =
  | { state: "idle" }
  | { state: "loading" }
  | {
      state: "ok";
      staffId: string;
      staffName: string;
      mode: string;
      reason: string;
    }
  | { state: "no_match"; reason: string };

const MODE_LABEL: Record<string, string> = {
  round_robin: "Round Robin",
  least_busy: "Least Busy",
  priority: "Priority",
  weighted: "Weighted",
  manual: "Manual",
  no_rule: "No rule",
};

export default function NewRoundRobinModal({
  open,
  onClose,
  onCreated,
  viewerRole,
  viewerUserId,
}: NewRoundRobinModalProps) {
  // ── Customer / service / time ───────────────────────────────
  const [customerMode, setCustomerMode] = useState<"select" | "create">("select");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerLite[]>([]);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [pickedCustomer, setPickedCustomer] = useState<CustomerLite | null>(null);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  const [services, setServices] = useState<ServiceLite[]>([]);
  const [serviceId, setServiceId] = useState<string>("");
  const [startAt, setStartAt] = useState<string>("");

  const [notes, setNotes] = useState("");
  const [internalNotes, setInternalNotes] = useState("");
  const [sendConfirmation, setSendConfirmation] = useState(true);
  const [skipPayment, setSkipPayment] = useState(false);

  // Routing preview state
  const [preview, setPreview] = useState<RoutingPreview>({ state: "idle" });

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedService = useMemo(
    () => services.find((s) => s.id === serviceId) ?? null,
    [services, serviceId],
  );

  // ── Reset on open ───────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setCustomerMode("select");
    setCustomerId(null);
    setCustomerQuery("");
    setCustomerResults([]);
    setPickedCustomer(null);
    setNewCustomerName("");
    setNewCustomerEmail("");
    setNewCustomerPhone("");
    setServiceId("");
    setStartAt("");
    setNotes("");
    setInternalNotes("");
    setSendConfirmation(true);
    setSkipPayment(false);
    setPreview({ state: "idle" });
    setError(null);
    setSubmitting(false);
  }, [open]);

  // ── Service lookup ──────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const res = await fetch("/api/services", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const list = Array.isArray(data) ? data : [];
        setServices(
          list.map((s: ServiceLite) => ({
            id: s.id,
            name: s.name,
            durationMinutes: s.durationMinutes,
            price: s.price,
            videoProvider: s.videoProvider,
          })),
        );
      } catch (e) {
        console.warn("[NewRoundRobinModal] services load failed:", e);
      }
    })();
  }, [open]);

  // ── Customer search ─────────────────────────────────────────
  useEffect(() => {
    if (customerMode !== "select" || customerQuery.trim().length < 2) {
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
            const list: CustomerLite[] = Array.isArray(data)
              ? data
              : data.customers ?? [];
            setCustomerResults(list.slice(0, 8));
          }
        } catch {
          /* swallow */
        } finally {
          setCustomerLoading(false);
        }
      })();
    }, 220);
    return () => clearTimeout(t);
  }, [customerQuery, customerMode]);

  // ── Routing preview (auto-refresh on service or time change) ──
  // Calls /api/tenant/routing/simulate — same engine the real booking
  // flow uses, but it's a pure dry run (no writes).
  useEffect(() => {
    if (!serviceId || !startAt) {
      setPreview({ state: "idle" });
      return;
    }
    const startDate = new Date(startAt);
    if (Number.isNaN(startDate.getTime())) {
      setPreview({ state: "idle" });
      return;
    }
    setPreview({ state: "loading" });
    const ctl = new AbortController();
    void (async () => {
      try {
        const res = await fetch("/api/tenant/routing/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceId,
            startAt: startDate.toISOString(),
          }),
          signal: ctl.signal,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          setPreview({
            state: "no_match",
            reason: data?.error ?? "Routing simulate failed.",
          });
          return;
        }
        const data: {
          decision:
            | { ok: true; staffId: string; mode: string; reason: string }
            | { ok: false; mode: string; reason: string };
          candidates: { staffId: string; staffName: string }[];
        } = await res.json();
        if (data.decision.ok) {
          // Hoist the narrowed discriminant fields so the closure inside
          // .find() doesn't re-widen the union back to the failure
          // shape (TS 5.x captures the union at the callback boundary).
          const pickedStaffId = data.decision.staffId;
          const pickedMode = data.decision.mode;
          const pickedReason = data.decision.reason;
          const picked = data.candidates.find((c) => c.staffId === pickedStaffId);
          setPreview({
            state: "ok",
            staffId: pickedStaffId,
            staffName: picked?.staffName ?? "Assigned staff",
            mode: pickedMode,
            reason: pickedReason,
          });
        } else {
          setPreview({
            state: "no_match",
            reason: humanizeNoMatch(data.decision.mode, data.decision.reason),
          });
        }
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return;
        setPreview({
          state: "no_match",
          reason: "Could not reach the routing engine.",
        });
      }
    })();
    return () => ctl.abort();
  }, [serviceId, startAt]);

  if (!open) return null;

  async function handleSubmit() {
    setError(null);
    if (!serviceId) {
      setError("Pick a service.");
      return;
    }
    if (!startAt) {
      setError("Pick a start time.");
      return;
    }
    if (preview.state !== "ok") {
      setError(
        "No staff matched the routing rule for this slot. Pick a different time or use One-on-One Appointment to assign manually.",
      );
      return;
    }
    if (customerMode === "select" && !customerId) {
      setError("Pick or create a customer.");
      return;
    }
    if (
      customerMode === "create" &&
      (!newCustomerName.trim() || !newCustomerEmail.trim())
    ) {
      setError("New customer needs a name and email.");
      return;
    }
    if (selectedService && selectedService.price > 0 && !skipPayment) {
      setError(
        "This is a paid service. Toggle 'Skip payment' to admin-book without charging the customer.",
      );
      return;
    }

    const startIso = new Date(startAt).toISOString();
    const basePayload = {
      serviceId,
      staffUserId: preview.staffId, // ← from the routing engine
      startAt: startIso,
      notes: notes.trim() || undefined,
      internalNotes: internalNotes.trim() || undefined,
      sendConfirmation,
      skipPayment,
      forceBook: false,
    };
    const payload =
      customerMode === "select"
        ? { ...basePayload, customerId }
        : {
            ...basePayload,
            customer: {
              name: newCustomerName.trim(),
              email: newCustomerEmail.trim(),
              phone: newCustomerPhone.trim() || undefined,
            },
          };

    setSubmitting(true);
    try {
      const res = await fetch("/api/tenant/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not create appointment.");
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
      aria-label="New round-robin appointment"
    >
      <div className="w-full max-w-xl bg-white sm:rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-screen sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <div className="flex items-center gap-3">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
              <Shuffle className="h-4 w-4" strokeWidth={2} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Round-robin appointment</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Auto-assign the staff based on your routing rule.
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
                className="text-xs text-violet-700 hover:text-violet-900"
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

          {/* Routing preview card */}
          <RoutingPreviewCard preview={preview} />

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
              placeholder="Visible only on the dashboard."
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
            disabled={submitting || preview.state !== "ok"}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Check className="h-3.5 w-3.5" />
            Auto-assign & book
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Inline card that surfaces the routing engine's pick + reasoning to
 *  the operator BEFORE they submit. Three states: idle (waiting for
 *  service+time), ok (pick + mode + reason), no_match (clean error). */
function RoutingPreviewCard({ preview }: { preview: RoutingPreview }) {
  if (preview.state === "idle") {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/40 p-3 text-[12px] text-slate-600 flex items-start gap-2">
        <Sparkles className="h-3.5 w-3.5 mt-0.5 text-slate-400" />
        <span>Pick a service and start time — we&apos;ll show who routing assigns.</span>
      </div>
    );
  }
  if (preview.state === "loading") {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[12px] text-slate-600 flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Resolving routing…
      </div>
    );
  }
  if (preview.state === "no_match") {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900 flex items-start gap-2">
        <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
        <span>
          <strong>No staff matched.</strong> {preview.reason}
        </span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-[12px] flex items-start gap-2.5">
      <Repeat className="h-3.5 w-3.5 mt-0.5 text-violet-600 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-semibold text-violet-900">Will assign to:</span>
          <span className="font-semibold text-slate-900">{preview.staffName}</span>
          <span className="rounded-full bg-violet-600 text-white px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider">
            {MODE_LABEL[preview.mode] ?? preview.mode}
          </span>
        </div>
        <div className="mt-0.5 text-[11px] text-violet-800">{preview.reason}</div>
      </div>
    </div>
  );
}

function humanizeNoMatch(mode: string, reason: string): string {
  switch (reason) {
    case "no_rule":
      return "No routing rule configured. Set one up under Settings → Staff Routing, or use One-on-One Appointment to assign manually.";
    case "rule_disabled":
      return "Your routing rule exists but is disabled.";
    case "manual_mode_fallback_to_legacy":
      return "Your routing rule is set to Manual. Switch to Round Robin, Least Busy, Priority, or Weighted under Settings → Staff Routing.";
    case "no_available_staff":
      return "No eligible staff are available for this service at that time (working hours, calendar conflicts, or PTO).";
    case "no_pick_in_pool":
      return "Routing returned no pick from the configured pool.";
    default:
      return `${reason}${mode ? ` (mode: ${mode})` : ""}`;
  }
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
