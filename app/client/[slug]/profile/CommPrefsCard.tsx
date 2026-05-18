"use client";

import * as React from "react";

type Prefs = {
  emailEnabled: boolean;
  smsEnabled: boolean;
  reminder24hEnabled: boolean;
  reminder1hEnabled: boolean;
  marketingEnabled: boolean;
};

export default function CommPrefsCard({
  slug,
  accent,
  initial,
}: {
  slug: string;
  accent: string;
  initial: Prefs;
}) {
  const [prefs, setPrefs] = React.useState<Prefs>(initial);
  const [busy, setBusy] = React.useState<keyof Prefs | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);

  async function toggle<K extends keyof Prefs>(key: K) {
    if (busy) return;
    const prev = prefs[key];
    const next = !prev;
    // Optimistic update: flip in the UI immediately, roll back on error.
    setPrefs((p) => ({ ...p, [key]: next }));
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`/api/client/${encodeURIComponent(slug)}/preferences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setPrefs(data as Prefs);
      setToast("Preferences saved");
      window.setTimeout(() => setToast(null), 2200);
    } catch (e) {
      setPrefs((p) => ({ ...p, [key]: prev }));
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        Communication preferences
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Choose what we&rsquo;re allowed to send. Operational confirmations always go out — these
        controls apply to reminders and optional messages.
      </p>

      <div className="mt-4 space-y-2.5">
        <Group label="Email">
          <Toggle
            label="Receive emails"
            hint="Master switch for all booking emails (reminders, etc.)."
            checked={prefs.emailEnabled}
            busy={busy === "emailEnabled"}
            onToggle={() => toggle("emailEnabled")}
            accent={accent}
          />
        </Group>

        <Group label="Reminder schedule">
          <Toggle
            label="24 hours before"
            hint="Send the day-before email reminder."
            checked={prefs.reminder24hEnabled}
            disabled={!prefs.emailEnabled}
            busy={busy === "reminder24hEnabled"}
            onToggle={() => toggle("reminder24hEnabled")}
            accent={accent}
          />
          <Toggle
            label="1 hour before"
            hint="Send the hour-before email reminder."
            checked={prefs.reminder1hEnabled}
            disabled={!prefs.emailEnabled}
            busy={busy === "reminder1hEnabled"}
            onToggle={() => toggle("reminder1hEnabled")}
            accent={accent}
          />
        </Group>

        <Group label="SMS">
          <Toggle
            label="Receive SMS"
            hint="Coming soon — needs your provider to support SMS delivery."
            checked={prefs.smsEnabled}
            disabled
            busy={false}
            onToggle={() => { /* gated */ }}
            accent={accent}
          />
        </Group>

        <Group label="Other">
          <Toggle
            label="Marketing & promotions"
            hint="Occasional offers and news. Off by default."
            checked={prefs.marketingEnabled}
            busy={busy === "marketingEnabled"}
            onToggle={() => toggle("marketingEnabled")}
            accent={accent}
          />
        </Group>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {toast && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {toast}
        </div>
      )}
    </section>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/40 p-3">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onToggle,
  busy,
  disabled = false,
  accent,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onToggle: () => void;
  busy: boolean;
  disabled?: boolean;
  accent: string;
}) {
  const isOn = checked && !disabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      onClick={onToggle}
      disabled={disabled || busy}
      className={
        "flex w-full items-start justify-between gap-3 rounded-lg border bg-white px-3 py-2.5 text-left transition disabled:cursor-not-allowed " +
        (disabled
          ? "border-slate-200 opacity-60"
          : "border-slate-200 hover:border-slate-300 hover:shadow-sm")
      }
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-900">{label}</div>
        {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
      </div>
      <span
        className={
          "relative mt-1 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition " +
          (isOn ? "" : "bg-slate-200")
        }
        style={isOn ? { backgroundColor: accent } : undefined}
        aria-hidden
      >
        <span
          className={
            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition " +
            (isOn ? "translate-x-4" : "translate-x-0.5")
          }
        />
        {busy && (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/80">…</span>
        )}
      </span>
    </button>
  );
}
