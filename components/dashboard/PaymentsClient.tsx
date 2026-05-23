"use client";

/**
 * Wave H Phase 5 — Settings → Payments client.
 *
 * Layout decisions (locked):
 *   • Unified provider list — one row per (provider × mode)
 *   • Two-step modal for adding a provider (credentials → save+test → reveal webhook URL)
 *   • LIVE/TEST chips + colored left border for mode separation
 *   • Inline expandable Activity panel per row showing last 10 webhook events
 *
 * Security guarantees the client honors:
 *   • Never displays the full secret. Only secretPreview ("•••XXXX").
 *   • Never logs anything to console
 *   • Webhook secret entry uses type="password"
 *   • Secret form fields cleared on success
 *   • Cross-tenant providerIds are unreachable (server filters every endpoint)
 */

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
  Zap,
} from "lucide-react";

type Mode = "live" | "test";
type Provider = "stripe" | "paypal";
type Status = "pending" | "verified" | "invalid" | "disabled";
type WebhookStatus = "unconfigured" | "configured" | "verified" | "failing";

// ─── Activation (Wave H — self-serve routing toggle) ──────────────────
//
// Mirrors lib/payments/activation.ts. The server is the source of truth
// for every field below; the client only renders + posts back the
// admin's intent (enabled true/false).
type RoutingMode =
  | "kill_switch"
  | "legacy_platform"
  | "tenant_vault_active"
  | "tenant_vault_strict";

type PrereqKey =
  | "providerExists"
  | "providerEnabled"
  | "providerDefault"
  | "providerVerified"
  | "webhookSecretConfigured";

interface PrereqItem {
  key: PrereqKey;
  label: string;
  ok: boolean;
  detail: string;
}

interface ActivationSnapshot {
  enabled: boolean;
  killSwitchActive: boolean;
  routingMode: RoutingMode;
  checklist: PrereqItem[];
  canActivate: boolean;
  blockedReason: string | null;
}

interface ProviderRow {
  id: string;
  tenantId: string;
  provider: Provider;
  mode: Mode;
  accountLabel: string;
  secretPreview: string;
  publishableKey: string | null;
  clientId: string | null;
  hasWebhookSecret: boolean;
  status: Status;
  lastVerifiedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  capabilities: Record<string, unknown>;
  isDefault: boolean;
  enabled: boolean;
  lastPaymentEventAt: string | null;
  webhookStatus: WebhookStatus;
  lastWebhookVerifiedAt: string | null;
  lastWebhookError: string | null;
  lastWebhookErrorAt: string | null;
  health: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface WebhookEventRow {
  id: string;
  externalEventId: string;
  eventType: string;
  status: string;
  error: string | null;
  bookingId: string | null;
  receivedAt: string;
  processingDurationMs: number | null;
  rawPayload: unknown;
  signatureHeaders: Record<string, string> | null;
}

interface Props {
  initialProviders: ProviderRow[];
  appBaseUrl: string;
  useTenantPaymentProviders: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function providerDisplayName(p: Provider): string {
  return p === "stripe" ? "Stripe" : "PayPal";
}

function StatusPill({ status }: { status: Status }) {
  const map: Record<Status, { bg: string; text: string; label: string }> = {
    verified: { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", label: "Verified" },
    pending: { bg: "bg-amber-50 border-amber-200", text: "text-amber-700", label: "Pending" },
    invalid: { bg: "bg-red-50 border-red-200", text: "text-red-700", label: "Invalid" },
    disabled: { bg: "bg-slate-100 border-slate-200", text: "text-slate-600", label: "Disabled" },
  };
  const s = map[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

function ModeChip({ mode }: { mode: Mode }) {
  if (mode === "live") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide bg-emerald-100 text-emerald-800 border border-emerald-300">
        LIVE
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold tracking-wide bg-amber-100 text-amber-800 border border-amber-300">
      TEST
    </span>
  );
}

function WebhookStatusPill({ status }: { status: WebhookStatus }) {
  const map: Record<WebhookStatus, { bg: string; text: string; label: string }> = {
    unconfigured: { bg: "bg-slate-50 border-slate-200", text: "text-slate-500", label: "Not configured" },
    configured: { bg: "bg-blue-50 border-blue-200", text: "text-blue-700", label: "Configured" },
    verified: { bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", label: "Verified" },
    failing: { bg: "bg-red-50 border-red-200", text: "text-red-700", label: "Failing" },
  };
  const s = map[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Ignore clipboard failures; the value is visible.
        }
      }}
      className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 transition-colors"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      {label ?? (copied ? "Copied" : "Copy")}
    </button>
  );
}

// ─── Activation panel (Wave H — self-serve routing toggle) ────────────

function routingModeChip(mode: RoutingMode) {
  switch (mode) {
    case "tenant_vault_active":
      return {
        bg: "bg-emerald-50 border-emerald-200",
        text: "text-emerald-800",
        label: "Tenant-owned billing — ACTIVE",
        sub: "Bookings route to your own Stripe/PayPal. Money lands in your account directly.",
      };
    case "tenant_vault_strict":
      return {
        bg: "bg-red-50 border-red-200",
        text: "text-red-800",
        label: "Tenant-owned billing — STRICT (broken)",
        sub: "Activation flag is on but no usable default provider — paid bookings will fail with 503. Disable below to fall back, or fix the provider.",
      };
    case "kill_switch":
      return {
        bg: "bg-amber-50 border-amber-200",
        text: "text-amber-800",
        label: "Operator kill switch active",
        sub: "PHASE3_KILL_SWITCH is enabled platform-wide. All paid bookings route to the legacy platform path regardless of your activation flag.",
      };
    case "legacy_platform":
    default:
      return {
        bg: "bg-slate-50 border-slate-200",
        text: "text-slate-700",
        label: "Platform billing (legacy)",
        sub: "Paid bookings flow through the ZentroMeet platform Stripe account. Activate below to switch to your own provider.",
      };
  }
}

function ActivationPanel({
  activation,
  onChanged,
  setError,
  setSuccess,
}: {
  activation: ActivationSnapshot | null;
  onChanged: () => Promise<void>;
  setError: (s: string | null) => void;
  setSuccess: (s: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  // First-paint skeleton — activation snapshot loads asynchronously.
  if (!activation) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking activation state…
        </div>
      </div>
    );
  }

  const mode = routingModeChip(activation.routingMode);
  // Toggle gates:
  //   • currently enabled → can ALWAYS disable (rollback)
  //   • currently disabled → can enable iff canActivate
  // Kill switch active doesn't block disabling; an admin should still
  // be able to clear their flag while the kill switch is on.
  const canToggle = activation.enabled || activation.canActivate;

  async function postEnabled(next: boolean) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/tenant/payment-routing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          // Server re-evaluated prereqs and refused. Surface the reason
          // and refresh so the checklist reflects the live failing item.
          setError(
            data?.blockedReason ?? "Activation blocked — setup incomplete.",
          );
        } else {
          throw new Error(data?.error ?? "Activation request failed");
        }
        await onChanged();
        return;
      }
      setSuccess(
        next
          ? "Tenant-owned billing activated. New paid bookings route to your provider."
          : "Tenant-owned billing disabled. New paid bookings route to the legacy platform path.",
      );
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Activation request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      {/* Header — mode + toggle */}
      <div className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-slate-900">Booking payment routing</h3>
            <span
              className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${mode.bg} ${mode.text}`}
            >
              {mode.label}
            </span>
          </div>
          <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">{mode.sub}</p>
        </div>

        {/* Toggle */}
        <label className="inline-flex items-center gap-3 cursor-pointer select-none">
          <span className="text-sm font-medium text-slate-700">
            {activation.enabled ? "Activated" : "Activate"}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={activation.enabled}
            disabled={busy || !canToggle}
            onClick={() => postEnabled(!activation.enabled)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              activation.enabled ? "bg-emerald-500" : "bg-slate-300"
            }`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
                activation.enabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </div>

      {/* Checklist — collapsed when active+canActivate, expanded when
          blocked or strict. Always-visible while inactive so admins see
          exactly what's needed to enable. */}
      {(!activation.enabled || activation.routingMode === "tenant_vault_strict") && (
        <div className="border-t border-slate-100 px-6 py-5 bg-slate-50/60">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div>
              <h4 className="text-sm font-semibold text-slate-900">
                Activation checklist
              </h4>
              <p className="text-xs text-slate-600 mt-0.5">
                All five must pass before tenant-owned billing can be activated.
              </p>
            </div>
            {activation.blockedReason && (
              <span className="text-xs text-amber-700 max-w-xs text-right">
                {activation.blockedReason}
              </span>
            )}
          </div>
          <ul className="space-y-2">
            {activation.checklist.map((item) => (
              <li
                key={item.key}
                className="flex items-start gap-3 rounded-lg bg-white border border-slate-200 px-3 py-2"
              >
                <div className="flex-shrink-0 mt-0.5">
                  {item.ok ? (
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <ShieldAlert className="h-4 w-4 text-amber-600" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-900">{item.label}</div>
                  <div
                    className={`text-xs mt-0.5 ${item.ok ? "text-slate-500" : "text-slate-700"}`}
                  >
                    {item.detail}
                  </div>
                </div>
                <span
                  className={`flex-shrink-0 text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded ${
                    item.ok
                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                      : "bg-amber-50 text-amber-700 border border-amber-200"
                  }`}
                >
                  {item.ok ? "OK" : "TODO"}
                </span>
              </li>
            ))}
          </ul>
          {activation.killSwitchActive && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
              <ShieldAlert className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>
                Operator override is in effect — activation is paused
                platform-wide while <code className="font-mono">PHASE3_KILL_SWITCH</code> is set.
                You can still configure providers; the toggle will become
                available once the override is cleared.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main client ──────────────────────────────────────────────────────

export default function PaymentsClient({
  initialProviders,
  appBaseUrl,
  useTenantPaymentProviders,
}: Props) {
  const [providers, setProviders] = useState(initialProviders);
  const [showAdd, setShowAdd] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Activation snapshot — null until the first fetch resolves. We seed
  // the routing badge from `useTenantPaymentProviders` (server prop) so
  // the at-a-glance state is correct on first paint; the full panel
  // appears once the snapshot loads.
  const [activation, setActivation] = useState<ActivationSnapshot | null>(null);

  // Auto-clear toasts.
  useEffect(() => {
    if (!success && !error) return;
    const t = setTimeout(() => {
      setSuccess(null);
      setError(null);
    }, 5000);
    return () => clearTimeout(t);
  }, [success, error]);

  async function refreshActivation() {
    try {
      const res = await fetch("/api/tenant/payment-routing", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load activation state");
      const data = (await res.json()) as ActivationSnapshot;
      setActivation(data);
    } catch (err) {
      // Don't toast — activation state is supplemental; provider list
      // is the primary surface and its own errors are loud enough.
      console.warn("[payments] activation refresh failed:", err);
    }
  }

  async function refresh() {
    try {
      const res = await fetch("/api/tenant/payment-providers", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setProviders(data.providers ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
    // ALWAYS refresh activation alongside providers — provider mutations
    // (set default, save webhook secret, test connection, soft-disable)
    // all change the prereq checklist. Doing this here means every
    // existing call site picks up the new behavior for free.
    await refreshActivation();
  }

  // Initial activation fetch — providers were server-rendered on first
  // paint but activation wasn't, so we need a client load to populate.
  useEffect(() => {
    void refreshActivation();
  }, []);

  const liveDefault = useMemo(
    () => providers.find((p) => p.mode === "live" && p.isDefault),
    [providers],
  );
  const testDefault = useMemo(
    () => providers.find((p) => p.mode === "test" && p.isDefault),
    [providers],
  );

  // Sort: live first (within live: default first), then test (default first).
  const sortedProviders = useMemo(() => {
    return [...providers].sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === "live" ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.provider.localeCompare(b.provider);
    });
  }, [providers]);

  return (
    <div className="space-y-6">
      {/* Hero / context strip */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold text-slate-900">Payment processors</h2>
              {/* Hero badge — uses live activation when available, falls
                  back to the server-rendered prop for first paint. */}
              {(activation?.enabled ?? useTenantPaymentProviders) ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 border border-emerald-200">
                  <Zap className="h-3 w-3" /> Active
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 border border-slate-200">
                  Dark-launch
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-slate-600 max-w-2xl">
              Connect your own Stripe or PayPal account. Customers pay you
              directly — ZentroMeet never appears in the money path.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition-colors shadow-sm"
          >
            <Plus className="h-4 w-4" /> Add provider
          </button>
        </div>
        {/* Defaults summary */}
        <div className="mt-4 flex flex-wrap gap-4 text-sm">
          <div className="flex items-center gap-2">
            <ModeChip mode="live" />
            <span className="text-slate-600">Default:</span>
            <span className="text-slate-900 font-medium">
              {liveDefault
                ? `${providerDisplayName(liveDefault.provider)}${liveDefault.accountLabel ? ` — ${liveDefault.accountLabel}` : ""}`
                : "— not set"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ModeChip mode="test" />
            <span className="text-slate-600">Default:</span>
            <span className="text-slate-900 font-medium">
              {testDefault
                ? `${providerDisplayName(testDefault.provider)}${testDefault.accountLabel ? ` — ${testDefault.accountLabel}` : ""}`
                : "— not set"}
            </span>
          </div>
        </div>
      </div>

      {/* Activation panel (Wave H — self-serve routing toggle).
          Loads its own state from /api/tenant/payment-routing on mount,
          and re-fetches every time provider mutations succeed (via the
          parent refresh()). */}
      <ActivationPanel
        activation={activation}
        onChanged={refresh}
        setError={setError}
        setSuccess={setSuccess}
      />

      {/* Toasts */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="h-4 w-4 text-red-600" /></button>
        </div>
      )}
      {success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-start gap-2">
          <Check className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span className="flex-1">{success}</span>
          <button onClick={() => setSuccess(null)}><X className="h-4 w-4 text-emerald-600" /></button>
        </div>
      )}

      {/* Provider list */}
      {sortedProviders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <div className="mx-auto h-12 w-12 rounded-full bg-slate-100 flex items-center justify-center">
            <Plus className="h-6 w-6 text-slate-400" />
          </div>
          <h3 className="mt-4 text-base font-medium text-slate-900">No providers yet</h3>
          <p className="mt-1 text-sm text-slate-600 max-w-md mx-auto">
            Add your Stripe or PayPal account to start accepting payments
            directly through your booking flow.
          </p>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition-colors"
          >
            <Plus className="h-4 w-4" /> Add provider
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {sortedProviders.map((p) => (
            <ProviderCard
              key={p.id}
              provider={p}
              appBaseUrl={appBaseUrl}
              busyId={busyId}
              setBusyId={setBusyId}
              setError={setError}
              setSuccess={setSuccess}
              refresh={refresh}
            />
          ))}
        </div>
      )}

      {/* Add modal */}
      {showAdd && (
        <AddProviderModal
          onClose={() => setShowAdd(false)}
          onSuccess={async (msg) => {
            setShowAdd(false);
            setSuccess(msg);
            await refresh();
          }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}

// ─── Provider card ────────────────────────────────────────────────────

function ProviderCard({
  provider,
  appBaseUrl,
  busyId,
  setBusyId,
  setError,
  setSuccess,
  refresh,
}: {
  provider: ProviderRow;
  appBaseUrl: string;
  busyId: string | null;
  setBusyId: (id: string | null) => void;
  setError: (s: string | null) => void;
  setSuccess: (s: string | null) => void;
  refresh: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [whSecretMode, setWhSecretMode] = useState(false);
  const [whSecret, setWhSecret] = useState("");
  const busy = busyId === provider.id;
  const borderColor = provider.mode === "live" ? "border-l-emerald-500" : "border-l-amber-500";
  const webhookUrl = `${appBaseUrl}/api/webhooks/payments/${provider.id}`;

  async function run(action: string, body?: object) {
    setBusyId(provider.id);
    setError(null);
    try {
      const url = `/api/tenant/payment-providers/${provider.id}${action ? `/${action}` : ""}`;
      const res = await fetch(url, {
        method: action ? "POST" : "DELETE",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Action failed");
      }
      return await res.json();
    } finally {
      setBusyId(null);
    }
  }

  async function onTest() {
    try {
      const data = await run("test");
      if (data.validation?.ok) {
        setSuccess("Connection verified.");
      } else {
        setError(`Validation failed: ${data.validation?.message ?? "unknown"}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test failed");
    }
  }

  async function onSetDefault() {
    try {
      await run("default");
      setSuccess(`Set as default for ${provider.mode} bookings.`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Set default failed");
    }
  }

  async function onToggleEnabled() {
    setBusyId(provider.id);
    setError(null);
    try {
      const res = await fetch(`/api/tenant/payment-providers/${provider.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !provider.enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Toggle failed");
      }
      setSuccess(provider.enabled ? "Provider disabled." : "Provider re-enabled.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete() {
    if (!confirm(`Delete this ${providerDisplayName(provider.provider)} ${provider.mode} provider? This cannot be undone.`)) return;
    try {
      await run("");
      setSuccess("Provider deleted.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  async function onSaveWebhookSecret() {
    if (!whSecret.trim()) {
      setError("Webhook secret cannot be empty.");
      return;
    }
    try {
      await run("webhook-secret", { secret: whSecret.trim() });
      setSuccess("Webhook signing secret saved.");
      setWhSecret("");
      setWhSecretMode(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  return (
    <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm border-l-4 ${borderColor} ${!provider.enabled ? "opacity-60" : ""}`}>
      {/* Header row */}
      <div className="p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <ModeChip mode={provider.mode} />
              <h3 className="text-base font-semibold text-slate-900">
                {providerDisplayName(provider.provider)}
                {provider.accountLabel && (
                  <span className="ml-2 font-normal text-slate-600">— {provider.accountLabel}</span>
                )}
              </h3>
              <StatusPill status={provider.status} />
              {provider.isDefault && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                  Default for {provider.mode}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
              <span>
                Secret: <code className="text-slate-900">{provider.secretPreview}</code>
              </span>
              {provider.capabilities.country !== undefined && (
                <span>Country: <span className="text-slate-900">{String(provider.capabilities.country).toUpperCase()}</span></span>
              )}
              {provider.capabilities.defaultCurrency !== undefined && (
                <span>Currency: <span className="text-slate-900">{String(provider.capabilities.defaultCurrency).toUpperCase()}</span></span>
              )}
              <span>
                Last verified: <span className="text-slate-900">{formatRelative(provider.lastVerifiedAt)}</span>
              </span>
            </div>
            {provider.status === "invalid" && provider.lastError && (
              <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
                <ShieldAlert className="inline h-3.5 w-3.5 mr-1" />
                {provider.lastError}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTest}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Test connection
            </button>
            {!provider.isDefault && provider.enabled && provider.status !== "invalid" && (
              <button
                type="button"
                onClick={onSetDefault}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                Set default
              </button>
            )}
            <button
              type="button"
              onClick={onToggleEnabled}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {provider.enabled ? "Disable" : "Re-enable"}
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-2 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              title="Delete provider"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Webhook section */}
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/50 p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-2">
                <h4 className="text-sm font-medium text-slate-900">Webhook</h4>
                <WebhookStatusPill status={provider.webhookStatus} />
                {provider.lastWebhookVerifiedAt && (
                  <span className="text-xs text-slate-600">
                    Verified {formatRelative(provider.lastWebhookVerifiedAt)}
                  </span>
                )}
                {provider.lastPaymentEventAt && (
                  <span className="text-xs text-slate-600">
                    · Last payment {formatRelative(provider.lastPaymentEventAt)}
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-600 mb-1">
                Configure this URL in your {providerDisplayName(provider.provider)} dashboard:
              </div>
              <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-mono text-slate-800 break-all">
                {webhookUrl || "(set APP_BASE_URL in .env)"}
                {webhookUrl && <CopyButton value={webhookUrl} />}
              </div>
              {provider.lastWebhookError && (
                <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
                  <ShieldAlert className="inline h-3.5 w-3.5 mr-1" />
                  {provider.lastWebhookError}
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="text-xs text-slate-600">
                Signing secret: <span className="text-slate-900 font-medium">{provider.hasWebhookSecret ? "Set" : "Not set"}</span>
              </div>
              {!whSecretMode ? (
                <button
                  type="button"
                  onClick={() => setWhSecretMode(true)}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  {provider.hasWebhookSecret ? "Rotate secret" : "Add signing secret"}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={whSecret}
                    onChange={(e) => setWhSecret(e.target.value)}
                    placeholder={provider.provider === "stripe" ? "whsec_..." : "PayPal webhook id"}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs w-56 font-mono"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={onSaveWebhookSecret}
                    disabled={busy}
                    className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setWhSecretMode(false);
                      setWhSecret("");
                    }}
                    className="text-xs text-slate-600 hover:text-slate-900"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Activity disclosure */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-3 flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          Activity (recent webhook events)
        </button>
        {expanded && <ActivityPanel providerId={provider.id} />}
      </div>
    </div>
  );
}

// ─── Activity panel ───────────────────────────────────────────────────

function ActivityPanel({ providerId }: { providerId: string }) {
  const [events, setEvents] = useState<WebhookEventRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/tenant/payment-providers/${providerId}/events?limit=20`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Failed to load events");
        const data = await res.json();
        setEvents(data.events ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [providerId]);

  if (loading) {
    return (
      <div className="mt-3 text-xs text-slate-500 flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading events...
      </div>
    );
  }
  if (error) {
    return <div className="mt-3 text-xs text-red-700">{error}</div>;
  }
  if (!events || events.length === 0) {
    return (
      <div className="mt-3 text-xs text-slate-500 italic">
        No webhook events recorded for this provider yet.
      </div>
    );
  }

  const statusColor = (s: string) => {
    if (s === "processed") return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (s === "received") return "bg-blue-50 text-blue-700 border-blue-200";
    if (s === "replay") return "bg-slate-50 text-slate-600 border-slate-200";
    if (s === "invalid_signature") return "bg-red-50 text-red-700 border-red-200";
    if (s === "unhandled") return "bg-amber-50 text-amber-700 border-amber-200";
    return "bg-slate-50 text-slate-600 border-slate-200";
  };

  return (
    <div className="mt-3 space-y-1.5">
      {events.map((ev) => (
        <div key={ev.id} className="rounded-md border border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setExpandedEventId(expandedEventId === ev.id ? null : ev.id)}
            className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-slate-50"
          >
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${statusColor(ev.status)}`}>
              {ev.status}
            </span>
            <code className="text-xs text-slate-700 truncate flex-1 min-w-0">{ev.eventType}</code>
            <span className="text-[11px] text-slate-500 flex-shrink-0">
              {formatRelative(ev.receivedAt)}
            </span>
            {ev.processingDurationMs !== null && (
              <span className="text-[11px] text-slate-400 flex-shrink-0">{ev.processingDurationMs}ms</span>
            )}
            {expandedEventId === ev.id ? (
              <ChevronDown className="h-3 w-3 text-slate-400" />
            ) : (
              <ChevronRight className="h-3 w-3 text-slate-400" />
            )}
          </button>
          {expandedEventId === ev.id && (
            <div className="border-t border-slate-200 px-3 py-2 space-y-2 bg-slate-50/50">
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <div>
                  <span className="text-slate-500">Event id: </span>
                  <code className="text-slate-800 break-all">{ev.externalEventId}</code>
                </div>
                {ev.bookingId && (
                  <div>
                    <span className="text-slate-500">Booking: </span>
                    <code className="text-slate-800 break-all">{ev.bookingId}</code>
                  </div>
                )}
              </div>
              {ev.error && (
                <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                  {ev.error}
                </div>
              )}
              {ev.signatureHeaders && Object.keys(ev.signatureHeaders).length > 0 && (
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-slate-600 hover:text-slate-900">
                    Signature headers ({Object.keys(ev.signatureHeaders).length})
                  </summary>
                  <pre className="mt-1 bg-white border border-slate-200 rounded p-2 overflow-x-auto text-[10px] font-mono text-slate-700">
                    {JSON.stringify(ev.signatureHeaders, null, 2)}
                  </pre>
                </details>
              )}
              {ev.rawPayload !== null && ev.rawPayload !== undefined && (
                <details className="text-[11px]">
                  <summary className="cursor-pointer text-slate-600 hover:text-slate-900">
                    Raw payload (redacted)
                  </summary>
                  <pre className="mt-1 bg-white border border-slate-200 rounded p-2 overflow-x-auto text-[10px] font-mono text-slate-700 max-h-96">
                    {JSON.stringify(ev.rawPayload, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Add provider modal (two-step) ────────────────────────────────────

function AddProviderModal({
  onClose,
  onSuccess,
  onError,
}: {
  onClose: () => void;
  onSuccess: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [provider, setProvider] = useState<Provider>("stripe");
  const [mode, setMode] = useState<Mode>("live");
  const [accountLabel, setAccountLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [publishableKey, setPublishableKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<
    | { ok: true; capabilities: Record<string, unknown>; providerId: string }
    | null
  >(null);

  async function submit() {
    if (!secret.trim() || secret.trim().length < 10) {
      onError("Secret looks too short to be valid.");
      return;
    }
    if (provider === "paypal" && !clientId.trim()) {
      onError("PayPal requires a client ID.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/tenant/payment-providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          mode,
          accountLabel: accountLabel.trim(),
          secret: secret.trim(),
          publishableKey: provider === "stripe" ? publishableKey.trim() || null : null,
          clientId: provider === "paypal" ? clientId.trim() || null : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onError(data.error ?? "Save failed");
        return;
      }
      // Clear the secret fields immediately so they aren't kept in
      // component state any longer than necessary.
      setSecret("");
      setClientId("");
      setPublishableKey("");
      if (data.validation?.ok) {
        setValidation({
          ok: true,
          capabilities: data.validation.capabilities ?? {},
          providerId: data.provider.id,
        });
        setStep(2);
      } else {
        onError(`Saved, but verification failed: ${data.validation?.message ?? "unknown"}. You can Test Connection again from the list.`);
        await onSuccess("Provider saved (verification failed — Test Connection to retry)");
      }
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200">
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <h2 className="text-lg font-semibold text-slate-900">
            {step === 1 ? "Add payment provider" : "Provider connected"}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          {step === 1 ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Provider</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(["stripe", "paypal"] as Provider[]).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setProvider(p)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                          provider === p
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        {providerDisplayName(p)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Mode</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(["live", "test"] as Mode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className={`rounded-lg border px-3 py-2 text-sm font-medium uppercase transition-colors ${
                          mode === m
                            ? m === "live"
                              ? "border-emerald-500 bg-emerald-50 text-emerald-800"
                              : "border-amber-500 bg-amber-50 text-amber-800"
                            : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Account label (optional)</label>
                <input
                  type="text"
                  value={accountLabel}
                  onChange={(e) => setAccountLabel(e.target.value)}
                  placeholder={provider === "stripe" ? "Production Stripe" : "PayPal Live"}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  maxLength={120}
                />
              </div>
              {provider === "stripe" ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Secret key <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder={mode === "live" ? "sk_live_..." : "sk_test_..."}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Publishable key (optional)</label>
                    <input
                      type="text"
                      value={publishableKey}
                      onChange={(e) => setPublishableKey(e.target.value)}
                      placeholder={mode === "live" ? "pk_live_..." : "pk_test_..."}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Client ID <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="text"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Client secret <span className="text-red-600">*</span>
                    </label>
                    <input
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                </>
              )}
              <div className="text-xs text-slate-500">
                We&apos;ll test the connection immediately and store credentials encrypted at rest.
              </div>
            </>
          ) : validation?.ok ? (
            <>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-start gap-2">
                <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">Connection verified.</div>
                  {validation.capabilities.country !== undefined && (
                    <div className="text-xs mt-1">
                      Account country: <span className="font-medium">{String(validation.capabilities.country).toUpperCase()}</span>
                      {validation.capabilities.defaultCurrency !== undefined && (
                        <> · Default currency: <span className="font-medium">{String(validation.capabilities.defaultCurrency).toUpperCase()}</span></>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="text-sm text-slate-800">
                <strong>Next step:</strong> configure the webhook URL below in your {providerDisplayName(provider)} dashboard.
              </div>
              <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs font-mono break-all">
                {`${typeof window !== "undefined" ? window.location.origin : ""}/api/webhooks/payments/${validation.providerId}`}
              </div>
              <div className="text-xs text-slate-600">
                After configuring it, paste the signing secret using &quot;Add signing secret&quot; on the provider row.
              </div>
            </>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-4 bg-slate-50/50 rounded-b-2xl">
          {step === 1 ? (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save & test
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={async () => {
                await onSuccess("Provider connected and verified.");
              }}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
