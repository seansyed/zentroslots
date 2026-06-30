"use client";

/**
 * Business Phone module — premium /dashboard/phone surface (launch redesign).
 *
 * IMPORTANT (honesty): the live feature is INBOUND FORWARDING + a bridge
 * "CLICK-TO-CALL" (ZentroMeet rings the staff's phone first, then connects the
 * customer). It is NOT a softphone — there is no in-browser audio. The browser
 * softphone is Phase 2 and is shown as "coming soon" with no fake controls.
 *
 * Layout: a hero card (product + status) on top, then a state-driven body:
 *   • marketing      → upgrade/add card (existing web Stripe add-on flow)
 *   • setup_pending  → "setup pending" banner, no controls
 *   • active         → number / dialer / usage / recent calls / click-to-call
 *   • disabled       → disabled banner
 *   • suspended      → billing-suspended banner
 *
 * Loads /api/tenant/phone/me (masked staff bridge number) and
 * /api/tenant/business-line/calls (recent + missed) ONLY in the active state.
 * Every action goes through the entitlement-gated API; this component never
 * contacts Telnyx and never shows a staff member's full personal number.
 */

import * as React from "react";
import {
  Phone,
  PhoneForwarded,
  PhoneOutgoing,
  PhoneIncoming,
  PhoneMissed,
  PhoneCall,
  Delete,
  Loader2,
  ShieldAlert,
  CheckCircle2,
  AlertCircle,
  SmartphoneNfc,
  Hourglass,
  Info,
} from "lucide-react";

import { Card, CardHeader, Button, Badge, Skeleton, toast } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import {
  callStatusLabel,
  callStatusTone,
  formatCallDuration,
  type CallLogRowView,
} from "@/lib/business-line-calls";
import {
  validateDialInput,
  buildCallBackPayload,
  phoneCallErrorMessage,
  OUTBOUND_CALL_SUCCESS_MESSAGE,
  dialPreview,
  isSupportedKeypadKey,
  canManageStaffAccess,
  CLICK_TO_CALL_EXPLAINER,
  SOFTPHONE_COMING_COPY,
  BUSINESS_PHONE_HERO,
  BUSINESS_PHONE_EMERGENCY_NOTICE,
  BUSINESS_PHONE_USAGE_RESET_NOTE,
  BUSINESS_PHONE_NO_OVERAGE_NOTE,
  BUSINESS_PHONE_CALLS_EMPTY,
  webPhoneStatusBadge,
  resolveWebPhoneView,
} from "@/lib/business-phone-ui";
import StaffPhoneAccess from "@/components/dashboard/StaffPhoneAccess";
import BusinessPhoneAddonCard from "@/components/dashboard/BusinessPhoneAddonCard";
import type { BusinessPhoneClientStatus } from "@/lib/business-phone-admin";

type MeView = {
  hasBusinessPhone: boolean;
  lineEnabled: boolean;
  canPlaceCalls: boolean;
  businessNumber: string | null;
  bridgePhoneNumberConfigured: boolean;
  bridgePhoneNumberMasked: string | null;
  usage: { period: string; minutesUsed: number; cap: number } | null;
};

const CALL_FILTERS = ["all", "completed", "missed", "answered", "failed", "rejected"] as const;
const KEYPAD = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

export default function PhoneClient({
  viewerRole,
  status,
}: {
  viewerRole: string;
  /** Server-authoritative Business Phone status — drives hero + body state. */
  status: BusinessPhoneClientStatus;
}) {
  // Operators (admin/manager) see the workspace call log + staff access admin;
  // staff see only their own dialer + number setup.
  const isOperator = canManageStaffAccess(viewerRole);
  // Forwarding configuration (number + on/off) is an admin-only setting — it
  // writes /api/tenant/business-line, which is admin-gated server-side.
  const isAdmin = viewerRole === "admin";
  const view = resolveWebPhoneView(status);
  const capReached = status.capReached;

  const [me, setMe] = React.useState<MeView | null>(null);
  const [meLoading, setMeLoading] = React.useState(true);
  const [meError, setMeError] = React.useState(false);

  // Call-forwarding settings (admin-only; loaded from /api/tenant/business-line).
  const [fwdLoaded, setFwdLoaded] = React.useState(false);
  const [fwdSaved, setFwdSaved] = React.useState<string | null>(null);
  const [fwdInput, setFwdInput] = React.useState("");
  const [fwdEnabled, setFwdEnabled] = React.useState(false);
  const [fwdSaving, setFwdSaving] = React.useState(false);
  const [fwdToggling, setFwdToggling] = React.useState(false);

  // Dialer
  const [dial, setDial] = React.useState("");
  const [placing, setPlacing] = React.useState(false);
  const [callResult, setCallResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  // Staff bridge number editor
  const [bridgeInput, setBridgeInput] = React.useState("");
  const [savingBridge, setSavingBridge] = React.useState(false);

  // Calls
  const [calls, setCalls] = React.useState<CallLogRowView[]>([]);
  const [callsLoading, setCallsLoading] = React.useState(true);
  const [statusFilter, setStatusFilter] = React.useState<string>("all");
  const [hasMore, setHasMore] = React.useState(false);
  const [missed, setMissed] = React.useState<CallLogRowView[]>([]);
  const [callingBackId, setCallingBackId] = React.useState<string | null>(null);

  const loadMe = React.useCallback(async () => {
    setMeLoading(true);
    setMeError(false);
    try {
      const res = await fetch("/api/tenant/phone/me", { cache: "no-store" });
      if (!res.ok) throw new Error("load failed");
      setMe((await res.json()) as MeView);
    } catch {
      setMeError(true);
    } finally {
      setMeLoading(false);
    }
  }, []);

  const fetchCalls = React.useCallback(async (status: string, offset: number, append: boolean) => {
    setCallsLoading(true);
    try {
      const params = new URLSearchParams({ limit: "25", offset: String(offset) });
      if (status !== "all") params.set("status", status);
      const res = await fetch(`/api/tenant/business-line/calls?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error("calls load failed");
      const data = (await res.json()) as { calls: CallLogRowView[]; hasMore: boolean };
      setCalls((cur) => (append ? [...cur, ...data.calls] : data.calls));
      setHasMore(data.hasMore);
    } catch {
      if (!append) setCalls([]);
      setHasMore(false);
    } finally {
      setCallsLoading(false);
    }
  }, []);

  const loadMissed = React.useCallback(async () => {
    try {
      const res = await fetch("/api/tenant/business-line/calls?status=missed&limit=5", { cache: "no-store" });
      if (!res.ok) throw new Error("missed load failed");
      const data = (await res.json()) as { calls: CallLogRowView[] };
      setMissed(data.calls);
    } catch {
      setMissed([]);
    }
  }, []);

  const loadForwarding = React.useCallback(async () => {
    try {
      const res = await fetch("/api/tenant/business-line", { cache: "no-store" });
      if (!res.ok) throw new Error("forwarding load failed");
      const data = (await res.json()) as { settings?: { forwardingNumber?: string | null; enabled?: boolean } };
      const fwd = data.settings?.forwardingNumber ?? null;
      setFwdSaved(fwd);
      setFwdInput(fwd ?? "");
      setFwdEnabled(Boolean(data.settings?.enabled));
    } catch {
      // soft-fail: the rest of the page still works without the forwarding card
    } finally {
      setFwdLoaded(true);
    }
  }, []);

  // Only the active state hits the entitlement-gated /me + calls endpoints —
  // marketing / pending / disabled / suspended render from `status` alone.
  React.useEffect(() => {
    if (!view.showActiveControls) return;
    void loadMe();
    if (isOperator) void loadMissed();
    if (isAdmin) void loadForwarding();
  }, [view.showActiveControls, loadMe, loadMissed, loadForwarding, isOperator, isAdmin]);

  React.useEffect(() => {
    if (view.showActiveControls && isOperator) void fetchCalls(statusFilter, 0, false);
  }, [view.showActiveControls, statusFilter, fetchCalls, isOperator]);

  // ── actions ──────────────────────────────────────────────────────
  async function placeCall(payload: Record<string, unknown>, opts?: { rowId?: string }) {
    if (opts?.rowId) setCallingBackId(opts.rowId);
    else setPlacing(true);
    setCallResult(null);
    try {
      const res = await fetch("/api/tenant/phone/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        const m = phoneCallErrorMessage(res.status, data?.error);
        setCallResult({ ok: false, message: m });
        toast(m, "error");
        return;
      }
      setCallResult({ ok: true, message: OUTBOUND_CALL_SUCCESS_MESSAGE });
      toast("Calling your phone…", "success");
      void loadMe();
      void loadMissed();
      void fetchCalls(statusFilter, 0, false);
    } catch {
      const m = "Couldn't place the call right now. Please try again.";
      setCallResult({ ok: false, message: m });
      toast(m, "error");
    } finally {
      setPlacing(false);
      setCallingBackId(null);
    }
  }

  function onNewCall() {
    const v = validateDialInput(dial);
    if (!v.ok) {
      setCallResult({ ok: false, message: v.message });
      return;
    }
    void placeCall({ toNumber: v.e164, callPurpose: "new_call" });
  }

  function onCallBack(row: CallLogRowView) {
    const payload = buildCallBackPayload(row.fromNumber);
    if (!payload) return;
    void placeCall(payload, { rowId: row.id });
  }

  async function saveForwarding() {
    setFwdSaving(true);
    try {
      const res = await fetch("/api/tenant/business-line", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ forwardingNumber: fwdInput.trim() === "" ? null : fwdInput.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { forwardingNumber?: string | null; error?: string };
      if (!res.ok) throw new Error(data?.error ?? "Couldn't save the forwarding number.");
      setFwdSaved(data.forwardingNumber ?? null);
      setFwdInput(data.forwardingNumber ?? "");
      toast("Forwarding number saved.", "success");
      void loadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save.", "error");
    } finally {
      setFwdSaving(false);
    }
  }

  async function toggleForwarding() {
    const next = !fwdEnabled;
    setFwdToggling(true);
    try {
      const res = await fetch("/api/tenant/business-line", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { enabled?: boolean; error?: string };
      if (!res.ok) throw new Error(data?.error ?? "Couldn't update forwarding.");
      setFwdEnabled(Boolean(data.enabled));
      toast(next ? "Forwarding enabled." : "Forwarding disabled.", "success");
      void loadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't update.", "error");
    } finally {
      setFwdToggling(false);
    }
  }

  async function saveBridge(clear: boolean) {
    setSavingBridge(true);
    try {
      const res = await fetch("/api/tenant/phone/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bridgePhoneNumber: clear ? null : bridgeInput.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as MeView & { error?: string };
      if (!res.ok) throw new Error(data?.error ?? "Couldn't save your number.");
      setMe(data); // server returns the masked view
      setBridgeInput(""); // never keep the full personal number on screen
      toast(clear ? "Calling number cleared." : "Calling number saved.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save.", "error");
    } finally {
      setSavingBridge(false);
    }
  }

  const hero = <PhoneHero status={status} />;

  // ── MARKETING (not active) — hero + add-on/upgrade card + safety note ──
  if (view.kind === "marketing") {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        {hero}
        <BusinessPhoneAddonCard status={status} />
        <EmergencyNotice />
      </div>
    );
  }

  // ── SETUP PENDING / DISABLED / SUSPENDED — hero + state banner, no controls ──
  if (view.kind === "setup_pending") {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        {hero}
        <PhoneStateCard
          tone="pending"
          title="Business Phone is active — setup pending"
          body="ParaFort / ZentroMeet is assigning your business number and forwarding line. You'll be able to make and receive calls as soon as it's ready."
        />
      </div>
    );
  }
  if (view.kind === "suspended") {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        {hero}
        <PhoneStateCard
          tone="alert"
          title="Business Phone is suspended"
          body="There's a billing issue with your subscription. Update your payment method on the Billing page to restore Business Phone."
        />
      </div>
    );
  }
  if (view.kind === "disabled") {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        {hero}
        <PhoneStateCard
          tone="alert"
          title="Business Phone is disabled"
          body="Business Phone is currently turned off for your workspace. Contact support if you think this is a mistake."
        />
      </div>
    );
  }

  // ── ACTIVE ───────────────────────────────────────────────────────
  if (meLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        {hero}
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (meError || !me) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        {hero}
        <Card>
          <CardHeader title="Business Phone isn't available right now" subtitle="We couldn't load your Business Phone. Please try again." />
          <div className="mt-4">
            <Button variant="secondary" onClick={() => void loadMe()}>
              Retry
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // Usage is server-authoritative (the tenant's REAL cap — may differ from the
  // marketing minutes in the hero). Never advertise a legacy cap as the default.
  const usedMinutes = me.usage?.minutesUsed ?? status.minutesUsed;
  const cap = me.usage?.cap ?? status.includedMinutes;
  const percentUsed = cap > 0 ? Math.min(100, Math.round((usedMinutes / cap) * 100)) : 0;
  const overCap = cap > 0 && usedMinutes >= cap;
  const preview = dialPreview(dial);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {hero}

      {/* Honest summary line */}
      <div className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 p-3.5 text-sm text-sky-900">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" strokeWidth={1.75} />
        <p>{CLICK_TO_CALL_EXPLAINER}</p>
      </div>

      {/* Cap reached — outbound blocked server-side; inbound still works. */}
      {capReached && (
        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-sm text-red-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" strokeWidth={1.75} />
          <p>
            You&apos;ve reached this month&apos;s included-minute limit. Outbound calling is paused until your next
            billing cycle. Inbound forwarding still works.
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Left: dialer + calls */}
        <div className="space-y-5 lg:col-span-2">
          {/* New Call / dial pad */}
          <Card>
            <div className="flex items-center justify-between">
              <CardHeader title="New call" subtitle="Dial a US or Canada number. We ring your phone first, then the customer." />
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-brand-subtle text-brand-accent">
                <PhoneOutgoing className="h-5 w-5" strokeWidth={1.75} />
              </span>
            </div>

            <div className="mt-4 grid gap-5 sm:grid-cols-[1fr_auto]">
              <div>
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="+1 (555) 123-4567"
                  value={dial}
                  onChange={(e) => {
                    setDial(e.target.value);
                    if (callResult) setCallResult(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !placing) onNewCall();
                  }}
                  className="h-14 w-full rounded-xl border border-border bg-surface px-4 text-center text-2xl font-semibold tracking-wide text-ink outline-none transition-colors placeholder:text-base placeholder:font-normal placeholder:tracking-normal placeholder:text-ink-subtle focus:border-brand-accent"
                  aria-label="Phone number to call"
                />

                {preview && (
                  <p className="mt-1.5 text-center text-xs text-ink-muted">
                    Will dial <span className="font-medium text-ink">{preview}</span>
                  </p>
                )}

                {/* Keypad. ✱ and # are disabled — US/Canada dialing only. */}
                <div className="mx-auto mt-4 grid max-w-[260px] grid-cols-3 gap-2">
                  {KEYPAD.map((k) => {
                    const supported = isSupportedKeypadKey(k);
                    return (
                      <button
                        key={k}
                        type="button"
                        disabled={!supported}
                        onClick={() => {
                          if (!supported) return;
                          setDial((d) => d + k);
                          if (callResult) setCallResult(null);
                        }}
                        title={supported ? undefined : "Not supported for US & Canada dialing"}
                        className={cn(
                          "flex h-12 items-center justify-center rounded-xl border border-border bg-surface text-lg font-semibold text-ink transition-colors",
                          supported
                            ? "hover:bg-surface-inset active:scale-[0.98]"
                            : "cursor-not-allowed text-ink-subtle opacity-30",
                        )}
                      >
                        {k}
                      </button>
                    );
                  })}
                </div>
                <div className="mx-auto mt-2 flex max-w-[260px] items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setDial("")}
                    disabled={dial === ""}
                    className="text-xs font-medium text-ink-subtle transition-colors hover:text-ink disabled:opacity-40"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => setDial((d) => d.slice(0, -1))}
                    disabled={dial === ""}
                    aria-label="Backspace"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink disabled:opacity-40"
                  >
                    <Delete className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                </div>
              </div>

              <div className="flex flex-col items-stretch justify-center gap-3 sm:w-44">
                <Button variant="primary" onClick={onNewCall} disabled={placing || !me.canPlaceCalls || capReached} className="h-12">
                  {placing ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <PhoneCall className="h-4 w-4" strokeWidth={2} /> Call (rings my phone)
                    </span>
                  )}
                </Button>
                {!me.canPlaceCalls && (
                  <p className="text-center text-xs text-amber-700">
                    {me.bridgePhoneNumberConfigured
                      ? "Calling isn't enabled for your account yet."
                      : "Set your calling number first."}
                  </p>
                )}
              </div>
            </div>

            {callResult && (
              <div
                className={cn(
                  "mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm",
                  callResult.ok
                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border-red-200 bg-red-50 text-red-700",
                )}
              >
                {callResult.ok ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
                ) : (
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
                )}
                <span>{callResult.message}</span>
              </div>
            )}
          </Card>

          {/* Missed calls (operator-only call log) */}
          {isOperator && missed.length > 0 && (
            <Card>
              <CardHeader title="Missed calls" subtitle="Recent inbound calls you missed." />
              <ul className="mt-3 divide-y divide-border">
                {missed.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <PhoneMissed className="h-4 w-4 shrink-0 text-red-500" strokeWidth={1.75} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">{c.fromNumber ?? "Unknown"}</div>
                        <div className="text-xs text-ink-muted">{formatTime(c.startedAt)}</div>
                      </div>
                    </div>
                    {c.direction === "inbound" && c.fromNumber && (
                      <Button
                        variant="secondary"
                        onClick={() => onCallBack(c)}
                        disabled={callingBackId === c.id || !me.canPlaceCalls || capReached}
                        className="h-8 shrink-0"
                      >
                        {callingBackId === c.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <PhoneOutgoing className="h-3.5 w-3.5" strokeWidth={2} /> Call back
                          </span>
                        )}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Recent calls (operator-only call log) */}
          {isOperator && (
            <Card>
              <CardHeader title="Recent calls" subtitle="Inbound and outbound calls on your business number." />
              <div className="mt-3 flex flex-wrap gap-1.5">
                {CALL_FILTERS.map((f) => {
                  const active = statusFilter === f;
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setStatusFilter(f)}
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                        active ? "bg-brand-accent text-white" : "bg-surface-inset text-ink-muted hover:text-ink",
                      )}
                    >
                      {f === "all" ? "All" : callStatusLabel(f)}
                    </button>
                  );
                })}
              </div>

              {callsLoading && calls.length === 0 ? (
                <div className="mt-4 space-y-2">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : calls.length === 0 ? (
                <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center">
                  <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-inset text-ink-subtle">
                    <PhoneCall className="h-5 w-5" strokeWidth={1.75} />
                  </span>
                  {statusFilter === "all" ? (
                    <>
                      <div className="text-sm font-medium text-ink">{BUSINESS_PHONE_CALLS_EMPTY.title}</div>
                      <p className="max-w-xs text-xs text-ink-muted">{BUSINESS_PHONE_CALLS_EMPTY.body}</p>
                    </>
                  ) : (
                    <div className="text-sm text-ink-muted">No {callStatusLabel(statusFilter).toLowerCase()} calls.</div>
                  )}
                </div>
              ) : (
                <>
                  <div className="mt-3 overflow-hidden rounded-lg border border-border">
                    <table className="w-full text-sm">
                      <thead className="bg-surface-inset/50 text-left text-[11px] uppercase tracking-wide text-ink-subtle">
                        <tr>
                          <th className="px-3 py-2 font-semibold">Direction</th>
                          <th className="px-3 py-2 font-semibold">Number</th>
                          <th className="px-3 py-2 font-semibold">Status</th>
                          <th className="px-3 py-2 font-semibold">Duration</th>
                          <th className="px-3 py-2 text-right font-semibold">Time</th>
                          <th className="px-3 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {calls.map((c) => {
                          const outbound = c.direction === "outbound";
                          const counterparty = outbound ? c.toNumber : c.fromNumber;
                          const canCallBack = c.direction === "inbound" && c.missed && Boolean(c.fromNumber);
                          return (
                            <tr key={c.id} className={cn(c.missed && "bg-red-50/60")}>
                              <td className="px-3 py-2">
                                <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                                  {c.missed ? (
                                    <PhoneMissed className="h-4 w-4 text-red-500" strokeWidth={1.75} />
                                  ) : outbound ? (
                                    <PhoneOutgoing className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
                                  ) : (
                                    <PhoneIncoming className="h-4 w-4 text-ink-subtle" strokeWidth={1.75} />
                                  )}
                                  {outbound ? "Outbound" : "Inbound"}
                                </span>
                              </td>
                              <td className="px-3 py-2 font-medium text-ink">{counterparty ?? "Unknown"}</td>
                              <td className="px-3 py-2">
                                <Badge tone={callStatusTone(c.status)}>{callStatusLabel(c.status)}</Badge>
                              </td>
                              <td className="px-3 py-2 text-ink-muted">{formatCallDuration(c.durationSeconds)}</td>
                              <td className="px-3 py-2 text-right text-xs text-ink-muted">{formatTime(c.startedAt)}</td>
                              <td className="px-3 py-2 text-right">
                                {canCallBack && (
                                  <button
                                    type="button"
                                    onClick={() => onCallBack(c)}
                                    disabled={callingBackId === c.id || !me.canPlaceCalls || capReached}
                                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-brand-accent transition-colors hover:bg-brand-subtle disabled:opacity-50"
                                  >
                                    {callingBackId === c.id ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <>
                                        <PhoneOutgoing className="h-3.5 w-3.5" strokeWidth={2} /> Call back
                                      </>
                                    )}
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {hasMore && (
                    <div className="mt-3 text-center">
                      <Button
                        variant="secondary"
                        onClick={() => void fetchCalls(statusFilter, calls.length, true)}
                        disabled={callsLoading}
                      >
                        {callsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Load more"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
        </div>

        {/* Right: identity + usage */}
        <div className="space-y-5">
          {/* Business number + forwarding */}
          <Card>
            <div className="flex items-center justify-between">
              <CardHeader title="Business number" subtitle="Shown as caller ID on every call." />
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-inset text-ink-subtle">
                <Phone className="h-5 w-5" strokeWidth={1.75} />
              </span>
            </div>
            <div className="mt-3 rounded-lg border border-border bg-surface-inset/40 p-4">
              {me.businessNumber ? (
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold text-ink">{me.businessNumber}</span>
                  <Badge tone={me.lineEnabled ? "green" : "neutral"}>{me.lineEnabled ? "Active" : "Off"}</Badge>
                </div>
              ) : (
                <div className="text-sm text-ink-muted">No business number assigned yet.</div>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
              <PhoneForwarded className="h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
              <span>
                Inbound calls forward to your phone.{" "}
                <span className="font-medium text-ink">{me.lineEnabled ? "Forwarding on" : "Forwarding off"}</span>.
              </span>
            </div>
          </Card>

          {/* Call forwarding settings — admin-only (writes /api/tenant/business-line) */}
          {isAdmin && (
            <Card>
              <div className="flex items-center justify-between">
                <CardHeader title="Call forwarding" subtitle="Calls to your business number ring this phone." />
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-inset text-ink-subtle">
                  <PhoneForwarded className="h-5 w-5" strokeWidth={1.75} />
                </span>
              </div>

              <div className="mt-3">
                <label htmlFor="bp-fwd" className="block text-sm font-medium text-ink">
                  Forwarding number
                </label>
                <p className="mt-0.5 text-xs text-ink-muted">US &amp; Canada numbers only.</p>
                <div className="mt-2 flex gap-2">
                  <input
                    id="bp-fwd"
                    type="tel"
                    inputMode="tel"
                    placeholder="+1 (555) 123-4567"
                    value={fwdInput}
                    disabled={!fwdLoaded || fwdSaving}
                    onChange={(e) => setFwdInput(e.target.value)}
                    className="h-10 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-brand-accent disabled:opacity-60"
                  />
                  <Button
                    variant="primary"
                    onClick={() => void saveForwarding()}
                    disabled={!fwdLoaded || fwdSaving || fwdInput.trim() === (fwdSaved ?? "")}
                  >
                    {fwdSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                  </Button>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <div className="text-sm font-medium text-ink">Forwarding</div>
                  <div className="text-xs text-ink-muted">
                    {fwdEnabled ? "Enabled" : "Disabled"} for your business number.
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={fwdEnabled}
                  aria-label="Toggle call forwarding"
                  disabled={!fwdLoaded || fwdToggling}
                  onClick={() => void toggleForwarding()}
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
                    fwdEnabled ? "bg-brand-accent" : "bg-surface-inset",
                    (!fwdLoaded || fwdToggling) && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span
                    className={cn(
                      "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
                      fwdEnabled ? "translate-x-5" : "translate-x-0.5",
                    )}
                  />
                </button>
              </div>
            </Card>
          )}

          {/* My calling number */}
          <Card>
            <div className="flex items-center justify-between">
              <CardHeader title="My calling number" subtitle="We ring this phone first, then connect the customer." />
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-inset text-ink-subtle">
                <SmartphoneNfc className="h-5 w-5" strokeWidth={1.75} />
              </span>
            </div>

            <div className="mt-3 flex items-center justify-between rounded-lg border border-border p-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Current</div>
                <div className="mt-0.5 truncate text-sm font-medium text-ink">
                  {me.bridgePhoneNumberConfigured ? me.bridgePhoneNumberMasked : "Not set"}
                </div>
              </div>
              <Badge tone={me.canPlaceCalls ? "green" : "amber"}>{me.canPlaceCalls ? "Ready" : "Setup needed"}</Badge>
            </div>

            <div className="mt-3">
              <label htmlFor="bp-bridge" className="block text-sm font-medium text-ink">
                {me.bridgePhoneNumberConfigured ? "Update number" : "Set your number"}
              </label>
              <p className="mt-0.5 text-xs text-ink-muted">US &amp; Canada only. Your personal number is never shown to customers.</p>
              <div className="mt-2 flex gap-2">
                <input
                  id="bp-bridge"
                  type="tel"
                  inputMode="tel"
                  placeholder="+1 (555) 123-4567"
                  value={bridgeInput}
                  disabled={savingBridge}
                  onChange={(e) => setBridgeInput(e.target.value)}
                  className="h-10 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-subtle focus:border-brand-accent"
                />
                <Button variant="primary" onClick={() => void saveBridge(false)} disabled={savingBridge || bridgeInput.trim() === ""}>
                  {savingBridge ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                </Button>
              </div>
              {me.bridgePhoneNumberConfigured && (
                <button
                  type="button"
                  onClick={() => void saveBridge(true)}
                  disabled={savingBridge}
                  className="mt-2 text-xs font-medium text-ink-subtle transition-colors hover:text-red-600 disabled:opacity-50"
                >
                  Clear my number
                </button>
              )}
            </div>
          </Card>

          {/* Usage — REAL tenant cap (not marketing minutes) */}
          <Card>
            <CardHeader title="Usage this month" subtitle={BUSINESS_PHONE_USAGE_RESET_NOTE} />
            <div className="mt-3">
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-ink">
                  <span className="font-semibold">{usedMinutes}</span> / {cap} minutes
                </span>
                <span className={cn("text-ink-muted", overCap && "font-medium text-red-600")}>
                  {percentUsed}%{overCap ? " · cap reached" : ""}
                </span>
              </div>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-inset">
                <div
                  className={cn("h-full rounded-full", overCap ? "bg-red-500" : "bg-brand-accent")}
                  style={{ width: `${percentUsed}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-ink-muted">{BUSINESS_PHONE_NO_OVERAGE_NOTE}</p>
            </div>
          </Card>

          {/* Softphone — honest "coming soon" note (no fake controls) */}
          <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-inset/40 p-4 text-xs text-ink-muted">
            <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
            <p>
              <span className="font-semibold text-ink">In-browser softphone — coming soon.</span> {SOFTPHONE_COMING_COPY}
            </p>
          </div>

          {/* Emergency notice */}
          <EmergencyNotice />
        </div>
      </div>

      {/* Staff phone access — operator-only admin management (P1.2.2). */}
      {isOperator && <StaffPhoneAccess />}
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Premium hero — product identity, price/minutes pills, and a status badge. */
function PhoneHero({ status }: { status: BusinessPhoneClientStatus }) {
  const badge = webPhoneStatusBadge(status.setupState);
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-brand-subtle/70 via-surface to-surface p-6 shadow-soft">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-accent text-white shadow-soft">
          <Phone className="h-7 w-7" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-ink">{BUSINESS_PHONE_HERO.title}</h2>
            <Badge tone={badge.tone}>{badge.label}</Badge>
          </div>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">{BUSINESS_PHONE_HERO.subtitle}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="inline-flex items-center rounded-full bg-surface px-3 py-1 text-sm font-semibold text-ink ring-1 ring-border">
              {BUSINESS_PHONE_HERO.price}
            </span>
            <span className="inline-flex items-center rounded-full bg-brand-subtle px-3 py-1 text-sm font-medium text-brand-accent ring-1 ring-brand-accent/15">
              {BUSINESS_PHONE_HERO.minutes}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Shared 911 / emergency disclaimer — honest (NOT "inbound only"). */
function EmergencyNotice() {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-inset/40 p-4 text-xs text-ink-muted">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
      <p>{BUSINESS_PHONE_EMERGENCY_NOTICE}</p>
    </div>
  );
}

/** Non-active state card (setup pending / disabled / suspended). No working
 *  controls — honest about what's available. */
function PhoneStateCard({
  tone,
  title,
  body,
}: {
  tone: "pending" | "alert";
  title: string;
  body: string;
}) {
  return (
    <Card>
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <span
          className={cn(
            "inline-flex h-12 w-12 items-center justify-center rounded-full",
            tone === "pending" ? "bg-amber-50 text-amber-700" : "bg-surface-inset text-ink-subtle",
          )}
        >
          {tone === "pending" ? (
            <Hourglass className="h-6 w-6" strokeWidth={1.75} />
          ) : (
            <ShieldAlert className="h-6 w-6" strokeWidth={1.75} />
          )}
        </span>
        <div>
          <div className="text-base font-semibold text-ink">{title}</div>
          <p className="mx-auto mt-1.5 max-w-sm text-sm text-ink-muted">{body}</p>
        </div>
        <Badge tone={tone === "pending" ? "amber" : "neutral"}>
          {tone === "pending" ? "Setup pending" : "Unavailable"}
        </Badge>
      </div>
    </Card>
  );
}
