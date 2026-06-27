"use client";

import * as React from "react";

/**
 * Client hook: reads the server-truth Business Phone entitlement from
 * /api/auth/me (`businessPhone.entitled`). Fail-safe — defaults to hidden
 * (false) until the fetch resolves, so the UI never flashes a Phone affordance
 * for an unentitled tenant. The server still enforces 402 on the APIs regardless.
 */
export function useBusinessPhoneEntitled(): { entitled: boolean; loading: boolean } {
  const [entitled, setEntitled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { businessPhone?: { entitled?: boolean } };
        if (!cancelled) setEntitled(data.businessPhone?.entitled === true);
      } catch {
        /* fail-safe: stays hidden */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { entitled, loading };
}
