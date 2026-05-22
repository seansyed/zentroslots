/**
 * BillingActions — Phase 16A.
 *
 * Per-plan CTA button. Surfaced inside the new pricing card grid.
 *
 * Behavior contract:
 *   - `planId` extended from 4 to 5 tiers (free / solo / pro / team /
 *     enterprise) — additive, no removal of the old tiers.
 *   - `interval` added so the button POSTs the right billing cadence
 *     to /api/billing/checkout. Defaults to "month" if omitted.
 *   - `stripePriceConfigured` lets the server-rendered parent pass
 *     down whether the env var for this plan+interval actually
 *     resolves to a Stripe Price ID. When false, the button renders
 *     disabled with explanatory copy — no fake checkout attempts,
 *     no opaque 400 from the API.
 *   - Enterprise tier still routes to checkout (Phase 16A made
 *     Enterprise self-serve at $250/$2,720).
 *   - No downgrade buttons — current-plan card renders a "Manage
 *     subscription" link to the Stripe Billing Portal instead.
 */
"use client";

import { useState } from "react";

type Props = {
  planId: "free" | "solo" | "pro" | "team" | "enterprise";
  interval?: "month" | "year";
  isCurrent: boolean;
  isAdmin: boolean;
  hasSubscription: boolean;
  stripeOn: boolean;
  /** Whether the Stripe Price ID for this plan+interval is actually
   *  configured. When false, we render the CTA disabled with a
   *  clear "Stripe price not configured" note. */
  stripePriceConfigured?: boolean;
};

export default function BillingActions({
  planId,
  interval = "month",
  isCurrent,
  isAdmin,
  hasSubscription,
  stripeOn,
  stripePriceConfigured = true,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No `trialDays` — paid plans bill immediately. Free is its
        // own permanent tier; any free-trial behavior would have to
        // be configured server-side per Stripe Price (not client-side).
        body: JSON.stringify({ plan: planId, interval }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Checkout failed");
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function portal() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Portal failed");
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  // ── Current plan ─────────────────────────────────────────────────
  if (isCurrent) {
    return (
      <div className="space-y-2">
        <div className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-brand-subtle/60 px-3 py-2 text-[11.5px] font-semibold uppercase tracking-[0.10em] text-brand-accent ring-1 ring-brand-accent/20">
          Current plan
        </div>
        {isAdmin && hasSubscription && (
          <button
            onClick={portal}
            disabled={busy || !stripeOn}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Loading…" : "Manage subscription"}
          </button>
        )}
        {error && <div className="text-[11px] text-red-600">{error}</div>}
      </div>
    );
  }

  // ── Free plan (informational; downgrades happen through portal) ─
  if (planId === "free") {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface-inset/40 px-3 py-2 text-center text-[11px] text-ink-subtle">
        Downgrades happen at period end through the billing portal.
      </div>
    );
  }

  // ── Paid plans — checkout flow ───────────────────────────────────
  const buttonDisabled = !isAdmin || busy || !stripeOn || !stripePriceConfigured;

  let buttonLabel: string;
  if (busy) buttonLabel = "Loading…";
  else if (!stripeOn) buttonLabel = "Stripe not configured";
  else if (!stripePriceConfigured) buttonLabel = "Price not configured";
  else if (!isAdmin) buttonLabel = "Admin only";
  else buttonLabel = `Upgrade to ${capitalize(planId)}`;

  return (
    <div className="space-y-2">
      <button
        onClick={checkout}
        disabled={buttonDisabled}
        className="w-full rounded-md bg-brand-accent px-3 py-2 text-[12px] font-semibold text-white shadow-[0_4px_14px_rgba(53,157,243,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(53,157,243,0.40)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-[0_4px_14px_rgba(53,157,243,0.32)]"
        title={
          !stripePriceConfigured
            ? `Set the matching STRIPE_PRICE_* env var to enable ${interval}ly ${planId} checkout.`
            : undefined
        }
      >
        {buttonLabel}
      </button>
      {!isAdmin && (
        <div className="text-[10.5px] text-ink-subtle">
          Only the workspace admin can change the plan.
        </div>
      )}
      {!stripePriceConfigured && stripeOn && isAdmin && (
        <div className="text-[10.5px] text-ink-subtle">
          Configure the Stripe Price for this tier in your environment to enable checkout.
        </div>
      )}
      {error && <div className="text-[11px] text-red-600">{error}</div>}
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
