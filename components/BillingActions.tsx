"use client";

import { useState } from "react";

type Props = {
  planId: "free" | "pro" | "team" | "enterprise";
  isCurrent: boolean;
  isAdmin: boolean;
  hasSubscription: boolean;
  stripeOn: boolean;
};

export default function BillingActions({ planId, isCurrent, isAdmin, hasSubscription, stripeOn }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkout() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planId, trialDays: 14 }),
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
    setBusy(true); setError(null);
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

  if (isCurrent) {
    return (
      <div>
        <div className="inline-flex items-center rounded-md bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
          Current plan
        </div>
        {isAdmin && hasSubscription && (
          <button
            onClick={portal}
            disabled={busy || !stripeOn}
            className="mt-3 w-full rounded-md border bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Manage subscription
          </button>
        )}
        {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
      </div>
    );
  }

  if (planId === "enterprise") {
    return (
      <a
        href="mailto:sales@example.com?subject=Enterprise plan"
        className="block rounded-md border px-3 py-2 text-center text-sm hover:bg-slate-50"
      >
        Contact sales
      </a>
    );
  }

  if (planId === "free") {
    return (
      <div className="text-xs text-slate-500">Downgrades happen through the billing portal.</div>
    );
  }

  return (
    <div>
      <button
        onClick={checkout}
        disabled={!isAdmin || busy || !stripeOn}
        className="w-full rounded-md bg-brand-accent px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Loading…" : "Upgrade"}
      </button>
      {!isAdmin && <div className="mt-1 text-xs text-slate-500">Only admins can change the plan.</div>}
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
