"use client";

import * as React from "react";

type State = { active: boolean; originalEmail?: string; impersonatedEmail?: string };

// Sticky banner shown whenever the request is operating under an active
// super-admin impersonation. Polled once on mount + on route changes by
// using the visibilitychange hint (no need for a router subscription —
// the impersonation lifecycle is short and we already re-render on
// router.refresh()).
export default function ImpersonationBanner() {
  const [state, setState] = React.useState<State | null>(null);
  const [busy, setBusy] = React.useState(false);

  const fetchState = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/impersonate/state", { cache: "no-store" });
      if (res.ok) setState(await res.json());
    } catch {
      // Silently ignore — banner just won't show.
    }
  }, []);

  React.useEffect(() => {
    fetchState();
    // Re-check when the tab regains focus — covers the case where the
    // user opens /admin in another tab, starts impersonation, then comes
    // back here.
    const onVisibility = () => {
      if (document.visibilityState === "visible") fetchState();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [fetchState]);

  async function exit() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/impersonate/exit", { method: "POST" });
      const data = (await res.json().catch(() => ({ redirectTo: "/admin" }))) as {
        redirectTo?: string;
      };
      window.location.href = data.redirectTo ?? "/admin";
    } finally {
      setBusy(false);
    }
  }

  if (!state?.active) return null;

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex items-center justify-between gap-3 bg-red-600 px-4 py-2 text-sm text-white shadow"
    >
      <div className="min-w-0 truncate">
        <span className="font-semibold">Impersonating:</span>{" "}
        <span className="font-mono">{state.impersonatedEmail ?? "tenant"}</span>{" "}
        <span className="opacity-80">as {state.originalEmail ?? "you"}</span>
      </div>
      <button
        onClick={exit}
        disabled={busy}
        className="shrink-0 rounded-md bg-white px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
      >
        {busy ? "Exiting…" : "Exit impersonation"}
      </button>
    </div>
  );
}
