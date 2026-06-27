"use client";

import * as React from "react";

export type BusinessPhoneVisibility = {
  entitled: boolean;
  hasPhoneAccess: boolean;
  canPlaceCalls: boolean;
};

/**
 * Client hook: reads the server-truth Business Phone visibility from
 * /api/auth/me (`businessPhone`). Fail-safe — every flag defaults to false
 * until the fetch resolves, so the UI never flashes a Phone affordance the
 * server wouldn't allow. The server still enforces 402/403 on the APIs.
 */
export function useBusinessPhone(): BusinessPhoneVisibility & { loading: boolean } {
  const [state, setState] = React.useState<BusinessPhoneVisibility>({
    entitled: false,
    hasPhoneAccess: false,
    canPlaceCalls: false,
  });
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { businessPhone?: Partial<BusinessPhoneVisibility> };
        if (!cancelled && data.businessPhone) {
          setState({
            entitled: data.businessPhone.entitled === true,
            hasPhoneAccess: data.businessPhone.hasPhoneAccess === true,
            canPlaceCalls: data.businessPhone.canPlaceCalls === true,
          });
        }
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

  return { ...state, loading };
}
