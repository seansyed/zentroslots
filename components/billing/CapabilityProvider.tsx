"use client";

/**
 * Client-side capability provider — server-hydrated, fail-closed.
 *
 * Architecture honesty:
 *   The codebase does not use TanStack Query / SWR. Adding a fetcher
 *   library would (a) be a large architectural change and (b) CREATE
 *   the unlock-flicker the user explicitly forbade — clients would
 *   render once unlocked, then re-render locked after the fetch
 *   resolves.
 *
 *   Instead this provider takes a server-fetched payload as a prop
 *   (via `loadCapabilitiesForTenant()` in `lib/billing/loadCapabilities`).
 *   The client tree consumes capabilities synchronously on first
 *   render — zero loading state, zero hydration mismatch.
 *
 * Fail-closed contract:
 *   - When mounted with `initial={null}` or used outside a provider,
 *     `useCapability()` returns `{ allowed: false, reason: "..." }`
 *     for every capability — premium UI renders as locked.
 *   - Phase 7 ("if capability endpoint fails: fail CLOSED for premium
 *     actions") is satisfied by construction.
 *
 * Refresh:
 *   `refresh()` is OPTIONAL. Useful after a Stripe upgrade callback
 *   to re-read capabilities without a full page reload. Internally
 *   hits `GET /api/tenant/capabilities`. Errors do not crash the UI
 *   — they leave the old payload in place and surface as a return
 *   value the caller can branch on.
 */
import * as React from "react";

import type { Capability, CapabilityCheck } from "@/lib/billing/capabilities";
import type { CapabilityPayload } from "@/lib/billing/loadCapabilities";

// Re-export for ergonomics — most consumers just import from this
// file rather than reaching into `lib/billing/...`.
export type { CapabilityPayload };
export type { Capability, CapabilityCheck };

// ─── Context ─────────────────────────────────────────────────────────

type ContextValue = {
  payload: CapabilityPayload | null;
  refresh: () => Promise<{ ok: boolean }>;
};

const CapabilityContext = React.createContext<ContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────────────────

/**
 * Cross-tab refresh signal. When a checkout completes in one tab, the
 * billing page broadcasts on this channel — every other open tab's
 * provider hears it and calls `refresh()` so their UI unlocks
 * immediately without a manual reload.
 *
 * Same-origin only (BroadcastChannel is per-origin). Falls back
 * silently on browsers without BroadcastChannel support (very old).
 */
const CAPABILITY_REFRESH_CHANNEL = "zb-capabilities-refresh";

export function CapabilityProvider({
  initial,
  children,
}: {
  /** Server-fetched payload. Pass null to mount the provider in a
   *  fail-closed state (every capability resolves to `allowed=false`). */
  initial: CapabilityPayload | null;
  children: React.ReactNode;
}) {
  const [payload, setPayload] = React.useState<CapabilityPayload | null>(initial);

  // Sync prop changes (e.g., parent re-renders with a refreshed payload
  // after a server action). Without this, a server-side refresh wouldn't
  // propagate into the provider after the initial mount.
  React.useEffect(() => {
    setPayload(initial);
  }, [initial]);

  const refresh = React.useCallback(async (): Promise<{ ok: boolean }> => {
    try {
      const res = await fetch("/api/tenant/capabilities", {
        cache: "no-store",
        credentials: "include",
      });
      if (!res.ok) return { ok: false };
      const next = (await res.json()) as CapabilityPayload;
      setPayload(next);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }, []);

  // Cross-tab refresh listener (Phase 6 — upgrade immediacy).
  // When checkout succeeds in one tab, every OTHER tab on the same
  // origin hears the broadcast and re-fetches capabilities. The
  // broadcasting tab itself doesn't re-fetch from the channel (it
  // already calls refresh() directly via PostCheckoutRefresh).
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(CAPABILITY_REFRESH_CHANNEL);
    const onMsg = (ev: MessageEvent) => {
      if (ev.data === "refresh") {
        void refresh();
      }
    };
    ch.addEventListener("message", onMsg);
    return () => {
      ch.removeEventListener("message", onMsg);
      ch.close();
    };
  }, [refresh]);

  // Memoize the context value so consumers don't rerender just because
  // the provider's parent rendered.
  const value = React.useMemo<ContextValue>(() => ({ payload, refresh }), [payload, refresh]);

  return <CapabilityContext.Provider value={value}>{children}</CapabilityContext.Provider>;
}

/**
 * Broadcast a capability refresh to all OTHER tabs on this origin.
 * Used by the billing page's PostCheckoutRefresh component after a
 * successful Stripe upgrade returns. No-op on unsupported browsers.
 */
export function broadcastCapabilityRefresh(): void {
  if (typeof window === "undefined") return;
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(CAPABILITY_REFRESH_CHANNEL);
    ch.postMessage("refresh");
    ch.close();
  } catch {
    // Some environments restrict BroadcastChannel — silent fail.
  }
}

// ─── Hooks ───────────────────────────────────────────────────────────

/**
 * Returns the capabilities-only slice. Returns `null` when used
 * outside a provider — callers MUST handle null (premium UI should
 * render as locked when the payload is missing).
 *
 * Most surfaces want `useCapability(name)` instead — this hook is
 * for components that need to enumerate all capabilities (e.g.,
 * the future Feature Controls visibility surface).
 */
export function useCapabilities(): Record<Capability, CapabilityCheck> | null {
  const ctx = React.useContext(CapabilityContext);
  return ctx?.payload?.capabilities ?? null;
}

/**
 * Returns the full payload (plan + limits + capabilities + billing)
 * plus the refresh function. Returns `null` when no provider — same
 * fail-closed contract as `useCapabilities()`.
 *
 * Use this hook when a surface needs the plan label ("Pro plan"),
 * a hard limit value (e.g. `maxCustomDomains`), OR needs to trigger
 * a refresh after a billing change.
 */
export function usePlanCapabilities(): {
  payload: CapabilityPayload | null;
  refresh: () => Promise<{ ok: boolean }>;
} {
  const ctx = React.useContext(CapabilityContext);
  // When used outside a provider, return a safe no-op so the caller
  // doesn't have to null-check the function reference.
  if (!ctx) return { payload: null, refresh: async () => ({ ok: false }) };
  return ctx;
}

/**
 * Convenience hook for the most common case: "is this single
 * capability allowed?". Fail-closed when the provider is missing.
 *
 *   const cap = useCapability("recurring_series");
 *   if (!cap.allowed) return <UpgradeGate ... />;
 */
export function useCapability(name: Capability): CapabilityCheck {
  const caps = useCapabilities();
  if (caps && caps[name]) return caps[name];
  // Fail-closed default. `currentPlan`/`requiredPlan` are best-effort
  // — they're used only for messaging, not for routing decisions.
  return {
    allowed: false,
    capability: name,
    currentPlan: "free",
    requiredPlan: "pro",
    reason: "Plan information is unavailable. Refresh the page or contact support.",
  };
}
