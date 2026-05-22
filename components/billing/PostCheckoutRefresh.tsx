"use client";

/**
 * Post-checkout capability refresh + cross-tab broadcast.
 *
 * Renders nothing visible. Mounts on the billing page when the URL
 * carries `?status=success` (set by Stripe's checkout redirect). On
 * mount it:
 *
 *   1. Re-fetches `/api/tenant/capabilities` so this tab unlocks
 *      premium UI without a manual reload.
 *   2. Broadcasts on the `zb-capabilities-refresh` channel so OTHER
 *      open tabs on this origin hear the change and re-fetch too.
 *
 * Phase 6 — upgrade immediacy. The webhook may still be in-flight
 * when the user lands here (Stripe's redirect can beat the webhook).
 * We re-fetch ONCE, then poll up to 5 more times (every 2s) until
 * the capability for the upgraded tier resolves to allowed. After
 * that we stop. This bounds the wait while never spinning forever.
 *
 * Why poll-after-redirect rather than poll-from-the-checkout-button:
 * the checkout button leaves OUR tab entirely. By the time Stripe
 * redirects back, the webhook has usually fired — polling here is
 * the right anchor.
 */
import * as React from "react";

import {
  broadcastCapabilityRefresh,
  usePlanCapabilities,
  type CapabilityPayload,
} from "./CapabilityProvider";

export function PostCheckoutRefresh({
  /** Force the refresh + broadcast. Pass false to render a no-op
   *  (so the parent server page can conditionally mount). */
  trigger,
}: {
  trigger: boolean;
}) {
  const { refresh } = usePlanCapabilities();

  React.useEffect(() => {
    if (!trigger) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 6; // ~10 seconds total (initial + 5 × 2s)

    async function tryRefresh() {
      if (cancelled) return;
      attempts++;
      const res = await refresh();
      if (!cancelled && res.ok) {
        // Tell other tabs.
        broadcastCapabilityRefresh();
        // Heuristic: if the user upgraded, at least ONE Pro+ capability
        // should now be `allowed`. If still all-locked after the
        // refresh and we've not hit the cap, schedule one more poll
        // (webhook may still be in flight).
        const stillLocked = await hasNoPremiumYet();
        if (stillLocked && attempts < MAX_ATTEMPTS) {
          setTimeout(tryRefresh, 2000);
        }
      } else if (!cancelled && attempts < MAX_ATTEMPTS) {
        // Refresh failed (transient network error); back off and retry.
        setTimeout(tryRefresh, 2000);
      }
    }

    void tryRefresh();
    return () => {
      cancelled = true;
    };
    // refresh is stable (memoized in the provider). Only trigger
    // matters for re-running this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  return null;
}

/**
 * Fetch the latest capabilities and check whether the tenant is
 * still entirely on free-tier capabilities. Used as a "did the
 * webhook fire yet?" heuristic for the polling backoff.
 */
async function hasNoPremiumYet(): Promise<boolean> {
  try {
    const res = await fetch("/api/tenant/capabilities", {
      cache: "no-store",
      credentials: "include",
    });
    if (!res.ok) return true;
    const payload = (await res.json()) as CapabilityPayload;
    // If ANY capability is allowed, we're past the wait — the upgrade
    // is visible to the server. (Free tenants have all capabilities
    // locked; any allowed means at least Solo+).
    const anyAllowed = Object.values(payload.capabilities).some((c) => c.allowed);
    return !anyAllowed;
  } catch {
    return true;
  }
}
