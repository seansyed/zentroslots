"use client";

import * as React from "react";

import { Button, Card, toast } from "@/components/ui/primitives";

type FlagMeta = { label: string; description: string; impact: string };

export default function FeatureControlsClient({
  initialFlags,
  defaults,
  meta,
  keys,
}: {
  initialFlags: Record<string, boolean>;
  defaults: Record<string, boolean>;
  meta: Record<string, FlagMeta>;
  keys: string[];
}) {
  const [flags, setFlags] = React.useState<Record<string, boolean>>(initialFlags);
  const [busy, setBusy] = React.useState(false);

  const dirty = React.useMemo(
    () => keys.some((k) => flags[k] !== initialFlags[k]),
    [flags, initialFlags, keys]
  );

  function setFlag(key: string, value: boolean) {
    setFlags((prev) => ({ ...prev, [key]: value }));
  }

  async function save() {
    setBusy(true);
    try {
      const res = await fetch("/api/tenant/features", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flags }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Save failed");
      toast("Settings saved", "success");
      // Refresh from server's sanitised response — protects against
      // any drift between what the client thought it sent and what
      // the server kept.
      if (data?.flags) setFlags(data.flags);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  function resetToDefaults() {
    setFlags({ ...defaults });
  }

  return (
    <div className="mt-6 space-y-4">
      {keys.map((k) => {
        const m = meta[k];
        if (!m) return null;
        const on = flags[k] ?? defaults[k] ?? true;
        const changed = initialFlags[k] !== on;
        return (
          <Card key={k} className="p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">{m.label}</h2>
                  {changed && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                      Unsaved
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-ink-muted">{m.description}</p>
                <p className="mt-2 text-xs text-ink-subtle">
                  <span className="font-medium text-ink-muted">When off:</span> {m.impact}
                </p>
              </div>
              <Toggle
                checked={on}
                disabled={busy}
                onChange={(v) => setFlag(k, v)}
                ariaLabel={`Toggle ${m.label}`}
              />
            </div>
          </Card>
        );
      })}

      <div className="sticky bottom-0 -mx-4 mt-6 flex items-center justify-end gap-2 border-t border-border bg-surface/80 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <button
          type="button"
          onClick={resetToDefaults}
          disabled={busy}
          className="text-xs text-ink-muted hover:text-ink disabled:opacity-50"
        >
          Reset to defaults
        </button>
        <Button onClick={save} disabled={!dirty || busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition " +
        (checked ? "bg-brand-accent" : "bg-slate-300") +
        (disabled ? " opacity-50" : "")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition " +
          (checked ? "translate-x-5" : "translate-x-0.5")
        }
      />
    </button>
  );
}
