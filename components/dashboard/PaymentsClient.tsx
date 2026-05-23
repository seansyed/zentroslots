"use client";

/**
 * Wave H — Settings → Payments client.
 *
 * ── Layout map (post onboarding-refinement) ───────────────────────────
 *
 *   PaymentsClient (top-level)
 *   ├── hero strip      — workspace context + routing-mode badge
 *   ├── ActivationPanel — toggle + prereq checklist + Continue-setup CTA
 *   ├── SlotGrid        — 4 fixed slots: one per (provider × mode)
 *   │     │                Empty slot → setSetupSlot()  → SetupWizard
 *   │     └                Filled slot → setManagedProviderId() → ManageDrawer
 *   ├── SetupWizard     — 4-step guided onboarding (modal)
 *   │                       Account → Keys → Webhook → Verify
 *   └── ManageDrawer    — side panel for filled providers
 *                           Status, Quick actions, Rotate keys,
 *                           Rotate webhook, Webhook URL, Danger zone
 *
 * ── Duplicate prevention ──────────────────────────────────────────────
 *
 * Three layers, defense in depth (NO single layer is the source of truth
 * — they're consistent because each is engineered to AND with the others):
 *
 *   • DB:  tenant_payment_providers_tenant_provider_mode_key (unique index)
 *   • API: upsertProvider() uses ON CONFLICT DO UPDATE so concurrent POSTs
 *          to the same slot become an in-place credential refresh
 *   • UI:  the slot grid never offers a "Set up" CTA for a filled slot —
 *          admins can only enter through Manage, which routes new keys
 *          through the documented rotation flow
 *
 * ── Credential rotation ───────────────────────────────────────────────
 *
 * The Manage drawer's "Rotate credentials" section is the documented
 * key-rotation path. It posts to the same /api/tenant/payment-providers
 * upsert endpoint — ON CONFLICT DO UPDATE re-encrypts the secret in place,
 * preserves the webhook signing secret (not in the SET clause unless
 * supplied), preserves is_default + enabled, and auto-runs Test Connection.
 * Future scheduled rotation (e.g. quarterly reminders) hangs off the
 * same Rotate section without re-architecting.
 *
 * ── Security guarantees the client honors ─────────────────────────────
 *
 *   • Never displays the full secret. Only secretPreview ("•••XXXX")
 *   • Never logs anything to console
 *   • All secret-input fields use type="password"
 *   • Secret form fields cleared on save (no lingering state)
 *   • Cross-tenant providerIds are unreachable (server filters every
 *     endpoint via getProviderRedacted / tenant-scoped queries)
 *   • Adapter errors are humanized via humanizeError() — raw provider
 *     messages are pre-redacted of any token-shaped substring before
 *     they leave the adapter (lib/payments/{stripe,paypal}/adapter.ts)
 */

import { useEffect, useMemo, useState } from "react";

import { Drawer } from "@/components/ui/primitives";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Settings2,
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
  onContinueSetup,
  hasLiveProvider,
}: {
  activation: ActivationSnapshot | null;
  onChanged: () => Promise<void>;
  setError: (s: string | null) => void;
  setSuccess: (s: string | null) => void;
  /** Called when admin clicks "Continue setup" — parent decides
   *  whether to open the wizard (no provider yet) or the manage
   *  drawer (provider exists but needs work). */
  onContinueSetup: () => void;
  /** Whether at least one LIVE provider row exists. Used to label
   *  the Continue Setup CTA correctly ("Set up Stripe Live" vs
   *  "Open Stripe Live"). */
  hasLiveProvider: boolean;
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
          {/* Continue-setup CTA. Only renders when there's actually
              something to do and the kill switch isn't blocking
              everything. The parent decides whether this opens the
              wizard for the empty Stripe Live slot or the manage
              drawer for the existing provider — we just emit intent. */}
          {!activation.canActivate && !activation.killSwitchActive && (
            <div className="mt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3">
              <div className="text-xs text-blue-900">
                <strong>Next:</strong>{" "}
                {hasLiveProvider
                  ? "Open your Stripe Live connection to finish the missing steps."
                  : "Start with Stripe Live — the wizard walks you through it."}
              </div>
              <button
                type="button"
                onClick={onContinueSetup}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                {hasLiveProvider ? "Open Stripe Live" : "Set up Stripe Live"}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
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

// ─── Slot grid (Wave H onboarding-refinement Phase 1) ────────────────
//
// One card per (provider × mode). There are exactly four possible
// slots — Stripe Live, Stripe Test, PayPal Live, PayPal Test. The DB
// unique index `tenant_payment_providers_tenant_provider_mode_key`
// enforces this at the storage layer; the slot grid mirrors that
// constraint visually so the admin can never see a "create new"
// affordance for a slot that's already filled.
//
// Empty slot → onSetupSlot({provider, mode}) — parent opens the wizard.
// Filled slot → onManageSlot(providerId)    — parent toggles inline mgmt.

const SLOT_DEFS: Array<{
  provider: Provider;
  mode: Mode;
  emptyTagline: string;
}> = [
  {
    provider: "stripe",
    mode: "live",
    emptyTagline: "Accept card payments worldwide. Funds settle into your bank account.",
  },
  {
    provider: "stripe",
    mode: "test",
    emptyTagline: "Sandbox testing — try the booking flow without real charges.",
  },
  {
    provider: "paypal",
    mode: "live",
    emptyTagline: "PayPal + Venmo. Helpful for customers who prefer not to enter card details.",
  },
  {
    provider: "paypal",
    mode: "test",
    emptyTagline: "PayPal sandbox — dry-run before going live.",
  },
];

function SlotGrid({
  providers,
  managedProviderId,
  onSetupSlot,
  onManageSlot,
}: {
  providers: ProviderRow[];
  managedProviderId: string | null;
  onSetupSlot: (slot: { provider: Provider; mode: Mode }) => void;
  onManageSlot: (providerId: string) => void;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900 mb-3">
        Connected accounts
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {SLOT_DEFS.map((slot) => {
          const filled = providers.find(
            (p) => p.provider === slot.provider && p.mode === slot.mode,
          );
          return (
            <SlotCard
              key={`${slot.provider}-${slot.mode}`}
              slot={slot}
              filled={filled ?? null}
              isManaged={filled ? managedProviderId === filled.id : false}
              onSetup={() => onSetupSlot({ provider: slot.provider, mode: slot.mode })}
              onManage={() => filled && onManageSlot(filled.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function SlotCard({
  slot,
  filled,
  isManaged,
  onSetup,
  onManage,
}: {
  slot: { provider: Provider; mode: Mode; emptyTagline: string };
  filled: ProviderRow | null;
  isManaged: boolean;
  onSetup: () => void;
  onManage: () => void;
}) {
  // Mode-driven left border tint — matches the existing per-provider
  // card pattern in ProviderCard so the visual language stays coherent
  // when the admin drills in.
  const borderColor =
    slot.mode === "live" ? "border-l-emerald-500" : "border-l-amber-500";

  if (!filled) {
    // Empty slot: tagline + "Set up →" CTA. Clicking enters the wizard
    // with this (provider, mode) locked.
    return (
      <button
        type="button"
        onClick={onSetup}
        className={`group text-left rounded-2xl border-l-4 ${borderColor} border border-slate-200 bg-white p-5 hover:border-slate-300 hover:shadow-sm transition-all`}
      >
        <div className="flex items-center gap-2 mb-2">
          <ModeChip mode={slot.mode} />
          <span className="text-base font-semibold text-slate-900">
            {providerDisplayName(slot.provider)}
          </span>
        </div>
        <p className="text-xs text-slate-600 leading-relaxed mb-4 min-h-[2.5rem]">
          {slot.emptyTagline}
        </p>
        <div className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-900 group-hover:text-slate-700">
          Set up
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </div>
      </button>
    );
  }

  // Filled slot: status + account info + "Manage" CTA.
  return (
    <div
      className={`rounded-2xl border-l-4 ${borderColor} border border-slate-200 bg-white p-5 ${isManaged ? "ring-2 ring-slate-900/10" : ""} ${!filled.enabled ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <ModeChip mode={filled.mode} />
        <span className="text-base font-semibold text-slate-900">
          {providerDisplayName(filled.provider)}
        </span>
        <StatusPill status={filled.status} />
      </div>
      <div className="text-xs text-slate-600 space-y-0.5 mb-4 min-h-[2.5rem]">
        {filled.accountLabel ? (
          <div className="text-slate-900 font-medium truncate">{filled.accountLabel}</div>
        ) : null}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {filled.capabilities.country !== undefined && (
            <span>{String(filled.capabilities.country).toUpperCase()}</span>
          )}
          {filled.capabilities.defaultCurrency !== undefined && (
            <span>{String(filled.capabilities.defaultCurrency).toUpperCase()}</span>
          )}
          {filled.isDefault && (
            <span className="text-blue-700 font-medium">Default for {filled.mode}</span>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-slate-500">
          {filled.hasWebhookSecret ? (
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3 w-3 text-emerald-600" />
              Webhook configured
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <ShieldAlert className="h-3 w-3" />
              Webhook not configured
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onManage}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {isManaged ? "Close" : "Manage"}
        </button>
      </div>
    </div>
  );
}

// ─── Setup wizard (Wave H onboarding-refinement Phase 2) ─────────────
//
// Guided 4-step flow. Replaces the developer-oriented one-shot modal
// with a sequence non-technical business owners can complete:
//
//   Step 1 — Account     — explain Stripe/PayPal + sign-up deep link
//   Step 2 — Keys        — guided key entry; POST creates the provider
//                          row, auto-runs Test Connection
//   Step 3 — Webhook     — show the receiver URL the admin pastes into
//                          the provider dashboard, list events to
//                          subscribe to, accept signing secret
//   Step 4 — Verify      — recap of state + activation CTA
//
// Mid-wizard close is allowed at any step. After step 2 the provider
// exists in pending/verified state already; if the admin closes before
// step 3 the slot card shows "Setup paused — Resume" so they can pick
// up later. (Phase 1 lands them right back on the Manage drawer, which
// is fine; Phase 3 will refine this resume path.)
//
// Everything routes through existing endpoints — no new server code.

interface SetupWizardProps {
  seedSlot: { provider: Provider; mode: Mode };
  appBaseUrl: string;
  onClose: () => void;
  onSuccess: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}

type WizardStep = 1 | 2 | 3 | 4;

// Provider-specific deep links + plain-English copy. Keeping this in
// one place so future providers slot in via a single record entry.
const PROVIDER_GUIDE: Record<
  Provider,
  Record<
    Mode,
    {
      signupUrl: string;
      apiKeysUrl: string;
      webhooksUrl: string;
      secretLabel: string;
      secretPrefix: string;
      publishableLabel: string | null;
      publishablePrefix: string | null;
      clientIdLabel: string | null;
      events: string[];
      eventsHint: string;
    }
  >
> = {
  stripe: {
    live: {
      signupUrl: "https://dashboard.stripe.com/register",
      apiKeysUrl: "https://dashboard.stripe.com/apikeys",
      webhooksUrl: "https://dashboard.stripe.com/webhooks",
      secretLabel: "Secret key",
      secretPrefix: "sk_live_…",
      publishableLabel: "Publishable key",
      publishablePrefix: "pk_live_…",
      clientIdLabel: null,
      events: [
        "checkout.session.completed",
        "checkout.session.expired",
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "charge.refunded",
      ],
      eventsHint:
        "These five events tell us when a booking is paid, when checkout times out, and when a refund happens.",
    },
    test: {
      signupUrl: "https://dashboard.stripe.com/register",
      apiKeysUrl: "https://dashboard.stripe.com/test/apikeys",
      webhooksUrl: "https://dashboard.stripe.com/test/webhooks",
      secretLabel: "Test secret key",
      secretPrefix: "sk_test_…",
      publishableLabel: "Test publishable key",
      publishablePrefix: "pk_test_…",
      clientIdLabel: null,
      events: [
        "checkout.session.completed",
        "checkout.session.expired",
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "charge.refunded",
      ],
      eventsHint: "Same five events as live — Stripe gives you separate webhook config for test mode.",
    },
  },
  paypal: {
    live: {
      signupUrl: "https://www.paypal.com/bizsignup/",
      apiKeysUrl: "https://developer.paypal.com/dashboard/applications/live",
      webhooksUrl: "https://developer.paypal.com/dashboard/applications/live",
      secretLabel: "Client secret",
      secretPrefix: "EH…",
      publishableLabel: null,
      publishablePrefix: null,
      clientIdLabel: "Client ID",
      events: [
        "CHECKOUT.ORDER.COMPLETED",
        "PAYMENT.CAPTURE.COMPLETED",
        "PAYMENT.CAPTURE.DENIED",
        "PAYMENT.CAPTURE.REFUNDED",
        "PAYMENT.CAPTURE.REVERSED",
      ],
      eventsHint:
        "These five events tell us when a booking is paid, when a payment is declined, and when a refund happens.",
    },
    test: {
      signupUrl: "https://developer.paypal.com/dashboard/",
      apiKeysUrl: "https://developer.paypal.com/dashboard/applications/sandbox",
      webhooksUrl: "https://developer.paypal.com/dashboard/applications/sandbox",
      secretLabel: "Sandbox client secret",
      secretPrefix: "EH…",
      publishableLabel: null,
      publishablePrefix: null,
      clientIdLabel: "Sandbox client ID",
      events: [
        "CHECKOUT.ORDER.COMPLETED",
        "PAYMENT.CAPTURE.COMPLETED",
        "PAYMENT.CAPTURE.DENIED",
        "PAYMENT.CAPTURE.REFUNDED",
        "PAYMENT.CAPTURE.REVERSED",
      ],
      eventsHint: "Same five events as live — PayPal gives you separate webhook config for sandbox.",
    },
  },
};

/** Map adapter errorClass to plain-English text. Falls back to the
 *  underlying message (always pre-redacted of secrets). */
function humanizeError(errorClass: string | undefined, raw: string | undefined): string {
  switch (errorClass) {
    case "auth":
      return "That key didn't work. Double-check you copied the whole value (including the prefix) from your provider dashboard.";
    case "permission":
      return "Your provider rejected the key because of restricted permissions. Use an unrestricted secret key from the API keys page.";
    case "rate_limit":
      return "Your provider is rate-limiting us. Wait a moment and try again.";
    case "transient":
      return "Your provider seems slow right now. Try again in a moment.";
    case "config":
      return raw ?? "Configuration error — check the value and try again.";
    default:
      return raw ?? "Something unexpected went wrong. Please try again or contact support.";
  }
}

function SetupWizard({
  seedSlot,
  appBaseUrl,
  onClose,
  onSuccess,
  onError,
}: SetupWizardProps) {
  const guide = PROVIDER_GUIDE[seedSlot.provider][seedSlot.mode];
  const [step, setStep] = useState<WizardStep>(1);
  const [busy, setBusy] = useState(false);
  const [accountLabel, setAccountLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [publishableKey, setPublishableKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  // Once step 2 succeeds we have a providerId to receive webhook events
  // and to attach a signing secret to. This is the pivot of the flow.
  const [providerId, setProviderId] = useState<string | null>(null);
  const [verifiedSummary, setVerifiedSummary] = useState<{
    country?: string;
    currency?: string;
  } | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

  const webhookUrl = providerId
    ? `${appBaseUrl || (typeof window !== "undefined" ? window.location.origin : "")}/api/webhooks/payments/${providerId}`
    : "";

  // ── Step 2 submit: create provider + auto-test ─────────────────────
  async function submitCredentials() {
    setStepError(null);
    if (!secret.trim() || secret.trim().length < 10) {
      setStepError("That secret looks too short. Make sure you copied the whole value.");
      return;
    }
    if (seedSlot.provider === "paypal" && !clientId.trim()) {
      setStepError("PayPal needs both a Client ID and a Client secret.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/tenant/payment-providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: seedSlot.provider,
          mode: seedSlot.mode,
          accountLabel: accountLabel.trim(),
          secret: secret.trim(),
          publishableKey:
            seedSlot.provider === "stripe" ? publishableKey.trim() || null : null,
          clientId: seedSlot.provider === "paypal" ? clientId.trim() || null : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStepError(data?.error ?? "We couldn't save the credentials. Try again.");
        return;
      }
      // Clear secrets from component state immediately.
      setSecret("");
      setPublishableKey("");
      setClientId("");
      if (data.validation?.ok) {
        setProviderId(data.provider.id);
        setVerifiedSummary({
          country: data.validation.capabilities?.country
            ? String(data.validation.capabilities.country).toUpperCase()
            : undefined,
          currency: data.validation.capabilities?.defaultCurrency
            ? String(data.validation.capabilities.defaultCurrency).toUpperCase()
            : undefined,
        });
        setStep(3);
      } else {
        setStepError(
          humanizeError(data.validation?.errorClass, data.validation?.message),
        );
      }
    } catch (e) {
      setStepError(e instanceof Error ? e.message : "We couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // ── Step 3 submit: save webhook signing secret ─────────────────────
  async function submitWebhookSecret() {
    setStepError(null);
    if (!webhookSecret.trim()) {
      setStepError(
        seedSlot.provider === "stripe"
          ? "Paste the signing secret that starts with whsec_… from your Stripe webhook page."
          : "Paste the webhook signing secret from your PayPal developer dashboard.",
      );
      return;
    }
    if (!providerId) {
      setStepError("Something went wrong tracking your provider. Close and re-open this wizard.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(
        `/api/tenant/payment-providers/${providerId}/webhook-secret`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: webhookSecret.trim() }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setStepError(data?.error ?? "We couldn't save the signing secret. Try again.");
        return;
      }
      setWebhookSecret("");
      setStep(4);
    } catch (e) {
      setStepError(e instanceof Error ? e.message : "We couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full max-w-2xl bg-white sm:rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-screen sm:max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 p-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Set up {providerDisplayName(seedSlot.provider)} {seedSlot.mode === "live" ? "Live" : "Test"}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {seedSlot.mode === "live"
                ? "Connect your provider account to accept real payments."
                : "Sandbox setup — try the booking flow without real charges."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close wizard"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Progress strip */}
        <div className="border-b border-slate-100 px-5 py-3 bg-slate-50/60">
          <ol className="flex items-center gap-2 text-xs">
            {[1, 2, 3, 4].map((n) => {
              const labels = ["Account", "Keys", "Webhook", "Verify"];
              const active = step === n;
              const done = step > n;
              return (
                <li
                  key={n}
                  className={`flex items-center gap-2 ${
                    active ? "text-slate-900 font-semibold" : done ? "text-emerald-700" : "text-slate-400"
                  }`}
                >
                  <span
                    className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${
                      done
                        ? "bg-emerald-600 text-white"
                        : active
                          ? "bg-slate-900 text-white"
                          : "bg-slate-200 text-slate-500"
                    }`}
                  >
                    {done ? <Check className="h-3 w-3" /> : n}
                  </span>
                  <span className="hidden sm:inline">{labels[n - 1]}</span>
                  {n < 4 && <span className="text-slate-300 mx-1">─</span>}
                </li>
              );
            })}
          </ol>
        </div>

        {/* Step body — scrolls when content overflows */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {step === 1 && (
            <>
              <p className="text-sm text-slate-700 leading-relaxed">
                {seedSlot.provider === "stripe" ? (
                  <>
                    Stripe lets you accept card payments and route funds directly into
                    your bank account. ZentroMeet never holds your customers&apos; money.
                  </>
                ) : (
                  <>
                    PayPal lets your customers pay with their PayPal balance, Venmo,
                    or a linked card — useful for buyers who don&apos;t want to share
                    card details. Funds settle into your PayPal balance.
                  </>
                )}
                {seedSlot.mode === "test" && (
                  <span className="block mt-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                    Test mode uses a sandbox account — no real money moves.
                  </span>
                )}
              </p>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900 mb-2">
                  Don&apos;t have an account yet?
                </div>
                <ol className="text-xs text-slate-700 space-y-1 list-decimal list-inside">
                  {seedSlot.provider === "stripe" ? (
                    <>
                      <li>Sign up with your business details (10 minutes)</li>
                      <li>Provide EIN/SSN and bank account for payouts</li>
                      <li>Verification is usually instant for sole proprietors</li>
                    </>
                  ) : (
                    <>
                      <li>Sign up for a PayPal Business account</li>
                      <li>Create an app in the PayPal Developer Dashboard</li>
                      <li>This gives you the Client ID and secret we&apos;ll use next</li>
                    </>
                  )}
                </ol>
                <a
                  href={guide.signupUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-blue-700 hover:text-blue-900"
                >
                  Open {providerDisplayName(seedSlot.provider)} sign-up
                  <ArrowRight className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="text-xs text-slate-500">
                Already have an account? Click <strong>I&apos;m ready</strong> below.
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-sm text-slate-700 leading-relaxed">
                Copy your <strong>{guide.secretLabel.toLowerCase()}</strong>
                {guide.clientIdLabel
                  ? ` and ${guide.clientIdLabel.toLowerCase()} `
                  : guide.publishableLabel
                    ? ` (and optionally your ${guide.publishableLabel.toLowerCase()}) `
                    : " "}
                from your {providerDisplayName(seedSlot.provider)} dashboard.
              </p>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900 mb-2">
                  Where to find {guide.secretLabel.toLowerCase()}:
                </div>
                <ol className="text-xs text-slate-700 space-y-1 list-decimal list-inside">
                  {seedSlot.provider === "stripe" ? (
                    <>
                      <li>Open the Stripe Dashboard</li>
                      <li>Click <strong>Developers</strong> in the top navigation</li>
                      <li>Click <strong>API keys</strong> in the left sidebar</li>
                      <li>
                        Make sure the mode toggle (top right) is set to{" "}
                        <strong>{seedSlot.mode === "live" ? "Live" : "Test"}</strong>
                      </li>
                      <li>
                        Click <strong>Reveal {seedSlot.mode === "live" ? "live" : "test"} key</strong>{" "}
                        next to <strong>Secret key</strong> and copy it
                      </li>
                    </>
                  ) : (
                    <>
                      <li>Open the PayPal Developer Dashboard</li>
                      <li>Click <strong>Apps & Credentials</strong></li>
                      <li>
                        Choose <strong>{seedSlot.mode === "live" ? "Live" : "Sandbox"}</strong>{" "}
                        at the top
                      </li>
                      <li>Open your REST app — copy both Client ID and Secret</li>
                    </>
                  )}
                </ol>
                <a
                  href={guide.apiKeysUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-blue-700 hover:text-blue-900"
                >
                  Open {providerDisplayName(seedSlot.provider)} API keys page
                  <ArrowRight className="h-3.5 w-3.5" />
                </a>
              </div>

              {seedSlot.mode === "live" && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <strong>Live vs Test:</strong> Live keys process real money. Use the
                  separate Test slot below the grid to dry-run the booking flow.
                </div>
              )}

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Label (optional)
                  </label>
                  <input
                    type="text"
                    value={accountLabel}
                    onChange={(e) => setAccountLabel(e.target.value)}
                    placeholder={
                      seedSlot.provider === "stripe"
                        ? `${seedSlot.mode === "live" ? "Main" : "Sandbox"} Stripe`
                        : `${seedSlot.mode === "live" ? "Main" : "Sandbox"} PayPal`
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    maxLength={120}
                  />
                </div>
                {guide.clientIdLabel && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {guide.clientIdLabel}
                    </label>
                    <input
                      type="text"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {guide.secretLabel}
                  </label>
                  <input
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder={guide.secretPrefix}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                    autoComplete="off"
                  />
                </div>
                {guide.publishableLabel && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      {guide.publishableLabel} (optional)
                    </label>
                    <input
                      type="text"
                      value={publishableKey}
                      onChange={(e) => setPublishableKey(e.target.value)}
                      placeholder={guide.publishablePrefix ?? ""}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                )}
              </div>

              <div className="text-xs text-slate-500">
                We&apos;ll test the connection immediately. Credentials are encrypted at rest.
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 flex items-start gap-2">
                <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">Account connected.</div>
                  {(verifiedSummary?.country || verifiedSummary?.currency) && (
                    <div className="text-xs mt-0.5">
                      {verifiedSummary?.country && <>Country: <strong>{verifiedSummary.country}</strong></>}
                      {verifiedSummary?.country && verifiedSummary?.currency && " · "}
                      {verifiedSummary?.currency && <>Currency: <strong>{verifiedSummary.currency}</strong></>}
                    </div>
                  )}
                </div>
              </div>

              <p className="text-sm text-slate-700 leading-relaxed">
                Webhooks let {providerDisplayName(seedSlot.provider)} tell us when a payment
                succeeds. Without this, bookings won&apos;t confirm.
              </p>

              <div>
                <div className="text-xs font-medium text-slate-700 mb-1">
                  Your webhook URL (paste this into {providerDisplayName(seedSlot.provider)}):
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <code className="flex-1 text-xs font-mono text-slate-900 break-all">{webhookUrl}</code>
                  <CopyButton value={webhookUrl} label="Copy URL" />
                </div>
              </div>

              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="text-sm font-semibold text-slate-900 mb-2">
                  How to add it:
                </div>
                <ol className="text-xs text-slate-700 space-y-1 list-decimal list-inside">
                  {seedSlot.provider === "stripe" ? (
                    <>
                      <li>Open Stripe Dashboard → Developers → Webhooks</li>
                      <li>Click <strong>Add endpoint</strong></li>
                      <li>Paste the URL above into <strong>Endpoint URL</strong></li>
                      <li>
                        Under <strong>Select events</strong>, choose the events listed below
                      </li>
                      <li>Click <strong>Add endpoint</strong></li>
                      <li>
                        Stripe shows a <strong>Signing secret</strong> starting with{" "}
                        <code className="font-mono">whsec_…</code> — click{" "}
                        <strong>Reveal</strong> and copy it
                      </li>
                    </>
                  ) : (
                    <>
                      <li>Open PayPal Developer Dashboard → your app → Webhooks</li>
                      <li>Click <strong>Add Webhook</strong></li>
                      <li>Paste the URL above into <strong>Webhook URL</strong></li>
                      <li>Subscribe to the events listed below</li>
                      <li>Click <strong>Save</strong></li>
                      <li>Copy the <strong>Webhook ID</strong> — that&apos;s your signing secret</li>
                    </>
                  )}
                </ol>
                <a
                  href={guide.webhooksUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 mt-3 text-sm font-medium text-blue-700 hover:text-blue-900"
                >
                  Open {providerDisplayName(seedSlot.provider)} webhooks page
                  <ArrowRight className="h-3.5 w-3.5" />
                </a>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-xs font-medium text-slate-700">
                    Events to subscribe to:
                  </div>
                  <CopyButton value={guide.events.join("\n")} label="Copy event list" />
                </div>
                <ul className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-mono space-y-0.5">
                  {guide.events.map((ev) => (
                    <li key={ev} className="text-slate-700">{ev}</li>
                  ))}
                </ul>
                <p className="text-xs text-slate-500 mt-1.5">{guide.eventsHint}</p>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {seedSlot.provider === "stripe" ? "Signing secret (whsec_…)" : "Webhook ID"}
                </label>
                <input
                  type="password"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  placeholder={seedSlot.provider === "stripe" ? "whsec_…" : "Webhook ID from PayPal"}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  autoComplete="off"
                />
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <ShieldCheck className="h-5 w-5 text-emerald-600" />
                  <span className="text-base font-semibold text-emerald-900">
                    {providerDisplayName(seedSlot.provider)} {seedSlot.mode === "live" ? "Live" : "Test"} is ready
                  </span>
                </div>
                <ul className="text-sm text-emerald-800 space-y-1">
                  <li className="flex items-center gap-2">
                    <Check className="h-3.5 w-3.5" />
                    Account connected
                    {verifiedSummary?.country && ` (${verifiedSummary.country}${verifiedSummary.currency ? `, ${verifiedSummary.currency}` : ""})`}
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-3.5 w-3.5" />
                    Connection verified
                  </li>
                  <li className="flex items-center gap-2">
                    <Check className="h-3.5 w-3.5" />
                    Webhook signing secret saved
                  </li>
                </ul>
              </div>
              <p className="text-sm text-slate-700 leading-relaxed">
                One more step to receive bookings through your provider:
              </p>
              <ol className="text-sm text-slate-700 space-y-2 list-decimal list-inside">
                {seedSlot.mode === "live" && (
                  <li>
                    Click <strong>Done</strong> to return to the Payments page
                  </li>
                )}
                <li>
                  In the activation panel at the top, click{" "}
                  <strong>Make default</strong> on this provider (if it isn&apos;t already)
                </li>
                <li>
                  Flip the <strong>Activate</strong> toggle to switch bookings to
                  tenant-owned billing
                </li>
              </ol>
              <p className="text-xs text-slate-500">
                You can always come back later — this slot is saved.
              </p>
            </>
          )}

          {/* Inline step error */}
          {stepError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span className="flex-1">{stepError}</span>
              <button onClick={() => setStepError(null)} aria-label="Dismiss error">
                <X className="h-4 w-4 text-red-600" />
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-200 p-4 bg-slate-50/50 sm:rounded-b-2xl">
          <button
            type="button"
            onClick={() => {
              if (step === 1) {
                onClose();
              } else if (step === 4) {
                // Treat the back-from-success state as not desirable —
                // bounce close instead.
                onClose();
              } else {
                setStep((s) => (s > 1 ? ((s - 1) as WizardStep) : s));
                setStepError(null);
              }
            }}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {step === 1 ? "Cancel" : step === 4 ? "Close" : "Back"}
          </button>
          {step === 1 && (
            <button
              type="button"
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              I&apos;m ready
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
          {step === 2 && (
            <button
              type="button"
              onClick={submitCredentials}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Connect
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              onClick={submitWebhookSecret}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Save webhook
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
          {step === 4 && (
            <button
              type="button"
              onClick={async () =>
                onSuccess(
                  `${providerDisplayName(seedSlot.provider)} ${seedSlot.mode === "live" ? "Live" : "Test"} connected.`,
                )
              }
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Manage drawer (Wave H onboarding-refinement Phase 3) ────────────
//
// Sectioned side drawer for a single connected provider. Replaces the
// Phase 1 inline expansion. All actions route through existing
// endpoints — this component owns NO new server code.
//
// Sections:
//   • Status        — verification + webhook + capability summary
//   • Quick actions — Test Connection · Make default · Soft disable
//   • Rotate keys   — paste new credentials (uses the same upsert
//                     ON CONFLICT path; webhook_secret preserved)
//   • Rotate hook   — paste new whsec_ / webhook ID
//   • Receiver URL  — show + copy the webhook endpoint URL
//   • Danger zone   — permanent delete
//
// Future scheduled rotation (e.g. "remind me every 90 days") hangs off
// the same Rotate keys section with no architecture change.

function ManageDrawer({
  provider,
  appBaseUrl,
  onClose,
  onChanged,
  setError,
  setSuccess,
}: {
  provider: ProviderRow | null;
  appBaseUrl: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  setError: (s: string | null) => void;
  setSuccess: (s: string | null) => void;
}) {
  // Local state for inline mutation forms. Keyed off the provider id so
  // switching between providers (a future enhancement) resets cleanly.
  const [busy, setBusy] = useState(false);
  const [newSecret, setNewSecret] = useState("");
  const [newPublishable, setNewPublishable] = useState("");
  const [newClientId, setNewClientId] = useState("");
  const [newWebhookSecret, setNewWebhookSecret] = useState("");
  // Reset form state every time the drawer's target provider changes.
  useEffect(() => {
    setNewSecret("");
    setNewPublishable("");
    setNewClientId("");
    setNewWebhookSecret("");
  }, [provider?.id]);

  // The Drawer primitive renders the overlay + slide animation; the
  // child markup is the panel body. We branch on provider===null to
  // keep the slide-out animation when closing (Drawer reads `open`).
  const open = provider !== null;

  async function postAction(
    action: string | null,
    body?: object,
    method: "POST" | "PATCH" | "DELETE" = "POST",
  ) {
    if (!provider) throw new Error("No provider");
    const url = `/api/tenant/payment-providers/${provider.id}${action ? `/${action}` : ""}`;
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data?.error ?? "Action failed");
    }
    return await res.json();
  }

  async function onTest() {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postAction("test");
      if (data.validation?.ok) setSuccess("Connection verified.");
      else setError(humanizeError(data.validation?.errorClass, data.validation?.message));
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test failed");
    } finally {
      setBusy(false);
    }
  }

  async function onMakeDefault() {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      await postAction("default");
      setSuccess(`Set as default for ${provider.mode} bookings.`);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Set default failed");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleEnabled() {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      await postAction(null, { enabled: !provider.enabled }, "PATCH");
      setSuccess(provider.enabled ? "Provider disabled." : "Provider re-enabled.");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRotateCredentials() {
    if (!provider) return;
    if (!newSecret.trim() || newSecret.trim().length < 10) {
      setError("That secret looks too short. Make sure you copied the whole value.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Upsert path — POST /api/tenant/payment-providers with the same
      // (provider, mode) hits ON CONFLICT DO UPDATE in upsertProvider().
      // webhook_secret is preserved when not supplied; is_default and
      // enabled are preserved (they're not in the SET clause). Status
      // resets to pending and the route auto-runs Test Connection.
      const res = await fetch("/api/tenant/payment-providers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: provider.provider,
          mode: provider.mode,
          accountLabel: provider.accountLabel ?? "",
          secret: newSecret.trim(),
          publishableKey:
            provider.provider === "stripe" ? newPublishable.trim() || null : null,
          clientId:
            provider.provider === "paypal" ? newClientId.trim() || null : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Rotation failed");
        return;
      }
      if (data.validation?.ok) {
        setSuccess("Credentials rotated. New key verified.");
        setNewSecret("");
        setNewPublishable("");
        setNewClientId("");
      } else {
        setError(
          `Credentials saved, but verification failed: ${humanizeError(data.validation?.errorClass, data.validation?.message)}`,
        );
      }
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rotation failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRotateWebhookSecret() {
    if (!provider) return;
    if (!newWebhookSecret.trim()) {
      setError("Paste the new webhook signing secret first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await postAction("webhook-secret", { secret: newWebhookSecret.trim() });
      setSuccess("Webhook signing secret rotated.");
      setNewWebhookSecret("");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!provider) return;
    if (
      !confirm(
        `Permanently delete this ${providerDisplayName(provider.provider)} ${provider.mode} connection? This cannot be undone — past bookings keep their payment_provider_id audit reference but no new bookings can route here.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await postAction(null, undefined, "DELETE");
      setSuccess("Provider deleted.");
      onClose();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const webhookUrl = provider
    ? `${appBaseUrl || (typeof window !== "undefined" ? window.location.origin : "")}/api/webhooks/payments/${provider.id}`
    : "";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="xl"
      side="right"
      ariaLabel="Manage payment provider"
    >
      {provider && (
        <>
          {/* Drawer header */}
          <div className="flex items-start justify-between p-5 border-b border-slate-200">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <ModeChip mode={provider.mode} />
                <h3 className="text-lg font-semibold text-slate-900">
                  {providerDisplayName(provider.provider)}
                </h3>
                <StatusPill status={provider.status} />
                {provider.isDefault && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
                    Default for {provider.mode}
                  </span>
                )}
              </div>
              {provider.accountLabel && (
                <p className="mt-1 text-sm text-slate-600 truncate">{provider.accountLabel}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700"
              aria-label="Close drawer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto">
            {/* Status section */}
            <DrawerSection title="Status" icon={<ShieldCheck className="h-4 w-4 text-slate-500" />}>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                <dt className="text-slate-500">Secret</dt>
                <dd className="text-slate-900 font-mono">{provider.secretPreview}</dd>
                {provider.capabilities.country !== undefined && (
                  <>
                    <dt className="text-slate-500">Country</dt>
                    <dd className="text-slate-900">{String(provider.capabilities.country).toUpperCase()}</dd>
                  </>
                )}
                {provider.capabilities.defaultCurrency !== undefined && (
                  <>
                    <dt className="text-slate-500">Currency</dt>
                    <dd className="text-slate-900">{String(provider.capabilities.defaultCurrency).toUpperCase()}</dd>
                  </>
                )}
                <dt className="text-slate-500">Last verified</dt>
                <dd className="text-slate-900">{formatRelative(provider.lastVerifiedAt)}</dd>
                <dt className="text-slate-500">Webhook</dt>
                <dd>
                  <WebhookStatusPill status={provider.webhookStatus} />
                </dd>
                {provider.lastWebhookVerifiedAt && (
                  <>
                    <dt className="text-slate-500">Last event</dt>
                    <dd className="text-slate-900">{formatRelative(provider.lastWebhookVerifiedAt)}</dd>
                  </>
                )}
              </dl>
              {provider.status === "invalid" && provider.lastError && (
                <div className="mt-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
                  <AlertCircle className="inline h-3.5 w-3.5 mr-1" />
                  {provider.lastError}
                </div>
              )}
            </DrawerSection>

            {/* Quick actions */}
            <DrawerSection title="Quick actions" icon={<Zap className="h-4 w-4 text-slate-500" />}>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={onTest}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Test Connection
                </button>
                {!provider.isDefault && (
                  <button
                    type="button"
                    onClick={onMakeDefault}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    Make default
                  </button>
                )}
                <button
                  type="button"
                  onClick={onToggleEnabled}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {provider.enabled ? "Soft-disable" : "Re-enable"}
                </button>
              </div>
              {!provider.enabled && (
                <p className="mt-2 text-xs text-slate-500">
                  This provider is soft-disabled — bookings won&apos;t route here.
                  Config and audit history are preserved.
                </p>
              )}
            </DrawerSection>

            {/* Webhook URL */}
            <DrawerSection
              title="Webhook URL"
              icon={<ShieldCheck className="h-4 w-4 text-slate-500" />}
            >
              <p className="text-xs text-slate-600 mb-2">
                Use this URL when adding the webhook endpoint in your
                {" "}{providerDisplayName(provider.provider)} dashboard. Tied to
                this provider only — you don&apos;t need to update it after
                rotating keys.
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <code className="flex-1 text-xs font-mono text-slate-900 break-all">{webhookUrl}</code>
                <CopyButton value={webhookUrl} label="Copy URL" />
              </div>
            </DrawerSection>

            {/* Rotate credentials */}
            <DrawerSection
              title="Rotate credentials"
              icon={<RefreshCw className="h-4 w-4 text-slate-500" />}
            >
              <p className="text-xs text-slate-600 mb-3">
                When {providerDisplayName(provider.provider)} issues you a new key
                (annual rotation, suspected leak, restricted-key upgrade), paste
                it here. Your webhook secret, default status, and audit history
                are preserved — only the credentials change.
              </p>
              <div className="space-y-2">
                {provider.provider === "paypal" && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      New Client ID
                    </label>
                    <input
                      type="text"
                      value={newClientId}
                      onChange={(e) => setNewClientId(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    New {provider.provider === "stripe" ? "secret key" : "client secret"}
                  </label>
                  <input
                    type="password"
                    value={newSecret}
                    onChange={(e) => setNewSecret(e.target.value)}
                    placeholder={
                      provider.provider === "stripe"
                        ? provider.mode === "live"
                          ? "sk_live_…"
                          : "sk_test_…"
                        : "Client secret"
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                    autoComplete="off"
                  />
                </div>
                {provider.provider === "stripe" && (
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      New publishable key (optional)
                    </label>
                    <input
                      type="text"
                      value={newPublishable}
                      onChange={(e) => setNewPublishable(e.target.value)}
                      placeholder={provider.mode === "live" ? "pk_live_…" : "pk_test_…"}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                      autoComplete="off"
                    />
                  </div>
                )}
                <button
                  type="button"
                  onClick={onRotateCredentials}
                  disabled={busy || !newSecret.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Replace credentials
                </button>
              </div>
            </DrawerSection>

            {/* Rotate webhook secret */}
            <DrawerSection
              title="Rotate webhook signing secret"
              icon={<RefreshCw className="h-4 w-4 text-slate-500" />}
            >
              <p className="text-xs text-slate-600 mb-3">
                {provider.provider === "stripe"
                  ? "Stripe lets you rotate the whsec_… signing secret without recreating the endpoint."
                  : "PayPal lets you re-issue your Webhook ID without recreating the endpoint."}
              </p>
              <div className="space-y-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    New {provider.provider === "stripe" ? "signing secret" : "webhook ID"}
                  </label>
                  <input
                    type="password"
                    value={newWebhookSecret}
                    onChange={(e) => setNewWebhookSecret(e.target.value)}
                    placeholder={provider.provider === "stripe" ? "whsec_…" : "Webhook ID"}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                    autoComplete="off"
                  />
                </div>
                <button
                  type="button"
                  onClick={onRotateWebhookSecret}
                  disabled={busy || !newWebhookSecret.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Replace signing secret
                </button>
              </div>
            </DrawerSection>

            {/* Danger zone */}
            <DrawerSection
              title="Danger zone"
              icon={<ShieldAlert className="h-4 w-4 text-red-500" />}
              tone="danger"
            >
              <p className="text-xs text-slate-600 mb-3">
                Permanent. Deletes the provider row and its credentials. Past
                bookings keep their <code className="font-mono">payment_provider_id</code> reference
                for audit but no new bookings route here. Prefer{" "}
                <strong>Soft-disable</strong> if you might re-enable later.
              </p>
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete permanently
              </button>
            </DrawerSection>
          </div>
        </>
      )}
    </Drawer>
  );
}

/** Sectioned wrapper used inside the ManageDrawer. Keeps spacing and
 *  visual rhythm consistent — section title + icon + body. */
function DrawerSection({
  title,
  icon,
  tone,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  tone?: "danger";
  children: React.ReactNode;
}) {
  return (
    <section
      className={`px-5 py-4 border-b border-slate-100 ${tone === "danger" ? "bg-red-50/30" : ""}`}
    >
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h4 className={`text-xs font-semibold uppercase tracking-wide ${tone === "danger" ? "text-red-700" : "text-slate-700"}`}>
          {title}
        </h4>
      </div>
      {children}
    </section>
  );
}

// ─── Main client ──────────────────────────────────────────────────────

export default function PaymentsClient({
  initialProviders,
  appBaseUrl,
  useTenantPaymentProviders,
}: Props) {
  const [providers, setProviders] = useState(initialProviders);
  // setupSlot: when an admin clicks "Set up" on an empty grid slot, we
  // open the SetupWizard with that (provider, mode) pre-locked. The
  // slot identity is the duplicate-prevention layer at the UX.
  const [setupSlot, setSetupSlot] = useState<{ provider: Provider; mode: Mode } | null>(null);
  // managedProviderId: when an admin clicks "Manage" on a filled slot,
  // we render the ProviderCard for that one provider below the grid.
  // Phase 3 will replace this inline panel with a proper side drawer.
  const [managedProviderId, setManagedProviderId] = useState<string | null>(null);
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
          {/* Phase 1 onboarding-refinement: the global "Add provider"
              button is gone. Each empty slot in the grid below carries
              its own "Set up" CTA so admins enter through a specific
              (provider, mode) — duplicate creation becomes impossible
              at the UX layer (the DB unique index is still the hard
              backstop). */}
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
          parent refresh()). The Phase 4 "Continue setup" CTA routes
          admins from a failing checklist directly to the right place. */}
      <ActivationPanel
        activation={activation}
        onChanged={refresh}
        setError={setError}
        setSuccess={setSuccess}
        hasLiveProvider={providers.some((p) => p.mode === "live")}
        onContinueSetup={() => {
          // If a live provider already exists, open it in the manage
          // drawer (so admin can rotate keys / paste webhook secret /
          // make default — whatever's missing). If not, launch the
          // wizard for the Stripe Live slot — Stripe is the most
          // common starting point for new tenants.
          const existingLive = providers.find((p) => p.mode === "live");
          if (existingLive) {
            setManagedProviderId(existingLive.id);
          } else {
            setSetupSlot({ provider: "stripe", mode: "live" });
          }
        }}
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

      {/* Slot grid — Wave H onboarding-refinement Phase 1.
          One card per (provider × mode). Empty slot → wizard; filled
          slot → inline Manage panel (replaced by a side drawer in
          Phase 3). The 4-slot model makes duplicate prevention visual:
          a filled slot never shows a "Set up" CTA, only "Manage". */}
      <SlotGrid
        providers={providers}
        managedProviderId={managedProviderId}
        onSetupSlot={(slot) => setSetupSlot(slot)}
        onManageSlot={(providerId) =>
          // Toggle: clicking Manage on the already-managed slot collapses it.
          setManagedProviderId((cur) => (cur === providerId ? null : providerId))
        }
      />

      {/* Manage drawer (Phase 3). Side panel matching the existing
          operational-drawer pattern. Sections: Status, Quick actions,
          Rotate credentials, Rotate webhook, Webhook URL, Danger zone.
          All actions route through existing endpoints — zero new
          server code. The drawer's rotate flows are the documented
          credential-rotation path: future scheduled rotation can hang
          off the same UI without re-architecting. */}
      <ManageDrawer
        provider={
          managedProviderId
            ? providers.find((x) => x.id === managedProviderId) ?? null
            : null
        }
        appBaseUrl={appBaseUrl}
        onClose={() => setManagedProviderId(null)}
        onChanged={refresh}
        setError={setError}
        setSuccess={setSuccess}
      />

      {/* Setup wizard (Phase 2). Guided 4-step flow: account → keys →
          webhook → verify. Each step has plain-English explanations,
          deep-link buttons into the provider's dashboard, copy buttons
          on every paste-target, and friendly errors. */}
      {setupSlot && (
        <SetupWizard
          seedSlot={setupSlot}
          appBaseUrl={appBaseUrl}
          onClose={() => setSetupSlot(null)}
          onSuccess={async (msg) => {
            setSetupSlot(null);
            setSuccess(msg);
            await refresh();
          }}
          onError={(msg) => setError(msg)}
        />
      )}
    </div>
  );
}
