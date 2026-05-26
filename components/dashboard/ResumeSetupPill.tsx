"use client";

/**
 * Phase Onboarding-UX — lightweight "Resume setup" pill.
 *
 * Rendered on the dashboard home when the user has dismissed the
 * checklist but their REQUIRED setup is not yet complete. Clicking
 * clears `onboarding_dismissed_at` via DELETE /api/onboarding/dismiss
 * and re-mounts the full checklist on the next render.
 *
 * Subtle. Single row. Never covers content.
 */

import * as React from "react";
import { Sparkles, ArrowRight } from "lucide-react";

export default function ResumeSetupPill({
  requiredDone,
  requiredTotal,
}: {
  requiredDone: number;
  requiredTotal: number;
}) {
  const [hidden, setHidden] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  if (hidden) return null;

  async function resume() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/onboarding/dismiss", { method: "DELETE" });
      // Reload so the server-rendered dashboard picks up the cleared
      // dismissed_at and re-renders the full checklist.
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="mb-6 flex items-center justify-between rounded-lg border border-border bg-surface-raised/40 px-3 py-2 text-[12px] shadow-soft">
      <div className="flex items-center gap-2 text-ink-muted">
        <Sparkles className="h-3.5 w-3.5 text-brand-accent" strokeWidth={1.75} />
        <span>
          <span className="font-medium text-ink">Setup is hidden</span>
          {requiredTotal > 0 ? (
            <>
              {" "}·{" "}
              <span className="tabular-nums">
                {requiredDone}/{requiredTotal}
              </span>{" "}
              required steps complete
            </>
          ) : null}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={resume}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md bg-brand-accent px-2.5 py-1 text-[11px] font-medium text-white hover:bg-brand-hover disabled:opacity-60"
        >
          {busy ? "Resuming…" : "Resume setup"}
          <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={() => setHidden(true)}
          aria-label="Hide for now"
          className="rounded-md px-1.5 py-1 text-[11px] text-ink-subtle hover:bg-surface-inset"
          title="Hide for this session"
        >
          ×
        </button>
      </div>
    </div>
  );
}
