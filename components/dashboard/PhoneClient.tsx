"use client";

/**
 * Business Phone module — Phase 1 surface (P1.2 + P1.2.A relabel).
 *
 * IMPORTANT (honesty): the deployed Phase 1 feature is INBOUND FORWARDING +
 * a bridge "CLICK-TO-CALL" (ZentroMeet rings the staff's phone first, then
 * connects the customer). It is NOT a softphone — there is no in-browser audio.
 * The real in-browser softphone is Phase 2 and is shown here as "coming", with
 * no fake controls.
 *
 * Tabs: Forwarding · Click-to-Call · Softphone (coming).
 *
 * Loads /api/tenant/phone/me (capability + masked staff bridge number + usage)
 * and /api/tenant/business-line/calls (recent + missed). Every action goes
 * through the entitlement-gated API; this component never contacts Telnyx and
 * never shows a staff member's full personal number.
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
  ArrowUpRight,
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
  BUSINESS_PHONE_TABS,
  businessPhoneTabLabel,
  CLICK_TO_CALL_EXPLAINER,
  SOFTPHONE_COMING_COPY,
  type BusinessPhoneTab,
} from "@/lib/business-phone-ui";
import StaffPhoneAccess from "@/components/dashboard/StaffPhoneAccess";
import type { BusinessPhoneAdminSetupState } from "@/lib/business-phone-admin";

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
  setupState,
  capReached,
}: {
  viewerRole: string;
  /** Server-authoritative setup state — drives the Phase 4 banners. */
  setupState: BusinessPhoneAdminSetupState;
  /** Monthly included-minute cap reached → outbound is blocked server-side. */
  capReached: boolean;
}) {
  // Operators (admin/manager) see the workspace call log + staff access admin;
  // staff see only their own dialer + number setup.
  const isOperator = canManageStaffAccess(viewerRole);
  const [tab, setTab] = React.useState<BusinessPhoneTab>("click_to_call");
  const [me, setMe] = React.useState<MeView | null>(null);
  const [meLoading, setMeLoading] = React.useState(true);
  const [meError, setMeError] = React.useState(false);

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

  React.useEffect(() => {
    void loadMe();
    if (isOperator) void loadMissed();
  }, [loadMe, loadMissed, isOperator]);

  React.useEffect(() => {
    if (isOperator) void fetchCalls(statusFilter, 0, false);
  }, [statusFilter, fetchCalls, isOperator]);

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

  // ── Phase 4 setup states (server-authoritative) ─────────────────
  // Non-active states render a clear banner and NO working controls — never a
  // fake dialer. (Hooks above always run; these returns are after them.)
  if (setupState === "setup_pending") {
    return (
      <PhoneStateCard
        tone="pending"
        title="Business Phone is active — setup pending"
        body="Your number setup is pending. ParaFort will assign your business number and forwarding line shortly. You'll be able to make and receive calls as soon as it's ready."
      />
    );
  }
  if (setupState === "suspended") {
    return (
      <PhoneStateCard
        tone="alert"
        title="Business Phone is suspended"
        body="There's a billing issue with your subscription. Update your payment method on the Billing page to restore Business Phone."
      />
    );
  }
  if (setupState === "disabled") {
    return (
      <PhoneStateCard
        tone="alert"
        title="Business Phone is disabled"
        body="Business Phone is currently turned off for your workspace. Contact support if you think this is a mistake."
      />
    );
  }

  // ── render ───────────────────────────────────────────────────────
  if (meLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  if (meError || !me) {
    return (
      <div className="mx-auto max-w-2xl">
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

  const usage = me.usage;
  const percentUsed = usage && usage.cap > 0 ? Math.min(100, Math.round((usage.minutesUsed / usage.cap) * 100)) : 0;
  const overCap = Boolean(usage && usage.cap > 0 && usage.minutesUsed >= usage.cap);
  const preview = dialPreview(dial);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      {/* Honest summary line */}
      <p className="text-sm text-ink-muted">
        Inbound forwarding and outbound <span className="font-medium text-ink">click-to-call</span> through your
        ZentroMeet business number. In-browser calling (softphone) is coming in Phase 2.
      </p>

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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {BUSINESS_PHONE_TABS.map((t) => {
          const active = tab === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "relative px-3.5 py-2 text-sm font-medium transition-colors",
                active ? "text-brand-accent" : "text-ink-muted hover:text-ink",
              )}
            >
              <span className="inline-flex items-center gap-1.5">
                {businessPhoneTabLabel(t)}
                {t === "softphone" && (
                  <span className="rounded bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-subtle">
                    Soon
                  </span>
                )}
              </span>
              {active && <span aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-brand-accent" />}
            </button>
          );
        })}
      </div>

      {/* ── FORWARDING TAB ── */}
      {tab === "forwarding" && (
        <div className="mx-auto max-w-2xl space-y-5">
          <Card>
            <div className="flex items-center justify-between">
              <CardHeader title="Inbound forwarding" subtitle="Calls to your business number ring through to your phone." />
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-surface-inset text-ink-subtle">
                <PhoneForwarded className="h-5 w-5" strokeWidth={1.75} />
              </span>
            </div>
            <div className="mt-3 rounded-lg border border-border bg-surface-inset/40 p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Business number</div>
              {me.businessNumber ? (
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-lg font-semibold text-ink">{me.businessNumber}</span>
                  <Badge tone={me.lineEnabled ? "green" : "neutral"}>{me.lineEnabled ? "Forwarding on" : "Forwarding off"}</Badge>
                </div>
              ) : (
                <div className="mt-1 text-sm text-ink-muted">No business number assigned yet.</div>
              )}
            </div>
            <p className="mt-3 text-sm text-ink-muted">
              When someone calls your business number, ZentroMeet forwards the call to your configured forwarding phone.
              This is inbound only.
            </p>
            {isOperator && (
              <a
                href="/dashboard/settings/business-line"
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-accent hover:text-brand-hover"
              >
                Manage forwarding settings <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
              </a>
            )}
          </Card>
        </div>
      )}

      {/* ── CLICK-TO-CALL TAB ── */}
      {tab === "click_to_call" && (
        <div className="space-y-5">
          {/* Honest explainer — this is NOT a softphone */}
          <div className="flex items-start gap-2.5 rounded-xl border border-sky-200 bg-sky-50 p-3.5 text-sm text-sky-900">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" strokeWidth={1.75} />
            <p>{CLICK_TO_CALL_EXPLAINER}</p>
          </div>

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
                  <CardHeader title="Recent calls" subtitle="Inbound and outbound calls on your business line." />
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
                    <div className="mt-4 rounded-lg border border-dashed border-border p-8 text-center text-sm text-ink-muted">
                      {statusFilter === "all" ? "No calls yet." : `No ${callStatusLabel(statusFilter).toLowerCase()} calls.`}
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
              {/* Business number */}
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
              </Card>

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

              {/* Usage */}
              {usage && (
                <Card>
                  <CardHeader title="Usage this month" subtitle={`Billing period ${usage.period}.`} />
                  <div className="mt-3">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-ink">
                        <span className="font-semibold">{usage.minutesUsed}</span> / {usage.cap} min
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
                  </div>
                </Card>
              )}

              {/* Safety note */}
              <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface-inset/40 p-4 text-xs text-ink-muted">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" strokeWidth={1.75} />
                <p>
                  Calls are placed through your ZentroMeet Business Phone number.{" "}
                  <span className="font-semibold text-ink">Emergency calling is not supported</span> — do not use this to
                  call 911 or any emergency or service number.
                </p>
              </div>
            </div>
          </div>

          {/* Staff phone access — operator-only admin management (P1.2.2). */}
          {isOperator && <StaffPhoneAccess />}
        </div>
      )}

      {/* ── SOFTPHONE TAB (Phase 2 — not built; no fake controls) ── */}
      {tab === "softphone" && (
        <div className="mx-auto max-w-2xl">
          <Card>
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-surface-inset text-ink-subtle">
                <Hourglass className="h-6 w-6" strokeWidth={1.75} />
              </span>
              <div>
                <div className="text-base font-semibold text-ink">In-browser softphone — coming in Phase 2</div>
                <p className="mx-auto mt-1.5 max-w-sm text-sm text-ink-muted">{SOFTPHONE_COMING_COPY}</p>
              </div>
              <Badge tone="neutral">Not available yet</Badge>
              <p className="mt-1 max-w-sm text-xs text-ink-subtle">
                Until then, use <span className="font-medium text-ink">Click-to-Call</span> — ZentroMeet rings your phone,
                then connects the customer.
              </p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Phase 4 — non-active state card (setup pending / disabled / suspended). No
 *  working controls — honest about what's available. */
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
    <div className="mx-auto max-w-2xl">
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
    </div>
  );
}
