"use client";

import * as React from "react";

type Initial = {
  name: string;
  email: string;
  phone: string;
  status: string;
};

export default function ProfileForm({
  slug,
  initial,
  accent,
}: {
  slug: string;
  initial: Initial;
  accent: string;
}) {
  const [v, setV] = React.useState({ name: initial.name, phone: initial.phone });
  const [editing, setEditing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const baseline = React.useRef({ name: initial.name, phone: initial.phone });

  const dirty =
    v.name.trim() !== baseline.current.name.trim() ||
    (v.phone ?? "").trim() !== (baseline.current.phone ?? "").trim();

  async function save() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/client/${encodeURIComponent(slug)}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: v.name.trim(),
          phone: v.phone.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      // Server normalizes (trim/null); use its values as the new baseline.
      baseline.current = { name: data.name, phone: data.phone ?? "" };
      setV({ name: data.name, phone: data.phone ?? "" });
      setEditing(false);
      setToast("Profile saved");
      window.setTimeout(() => setToast(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setV({ name: baseline.current.name, phone: baseline.current.phone });
    setEditing(false);
    setError(null);
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Your information
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Update what we use to contact you. Email stays the same so your sign-in link keeps working.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Edit
          </button>
        )}
      </div>

      <div className="mt-4 space-y-4 text-sm">
        <Field label="Name">
          {editing ? (
            <input
              value={v.name}
              onChange={(e) => setV({ ...v, name: e.target.value })}
              maxLength={120}
              autoComplete="name"
              className={INPUT}
              disabled={busy}
            />
          ) : (
            <div className="text-slate-900">{baseline.current.name}</div>
          )}
        </Field>

        <Field label="Email" hint="Read-only — used to send your sign-in link.">
          <div className="text-slate-900">{initial.email}</div>
        </Field>

        <Field label="Phone">
          {editing ? (
            <input
              value={v.phone}
              onChange={(e) => setV({ ...v, phone: e.target.value })}
              maxLength={40}
              autoComplete="tel"
              inputMode="tel"
              placeholder="+1 555 555 1234"
              className={INPUT}
              disabled={busy}
            />
          ) : (
            <div className="text-slate-900">{baseline.current.phone || "—"}</div>
          )}
        </Field>

        <Field label="Account status">
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium capitalize text-slate-700">
            {initial.status}
          </span>
        </Field>
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

      {editing && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty || !v.name.trim()}
            className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

const INPUT =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-400">{hint}</div>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
