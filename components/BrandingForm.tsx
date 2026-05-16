"use client";

import { useState } from "react";

type Initial = {
  name: string;
  logoUrl: string;
  primaryColor: string;
  tagline: string;
  description: string;
  bookingHeadline: string;
};

export default function BrandingForm({ initial, disabled }: { initial: Initial; disabled: boolean }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update<K extends keyof Initial>(k: K, val: Initial[K]) {
    setSaved(false);
    setV((cur) => ({ ...cur, [k]: val }));
  }

  async function save() {
    setBusy(true); setError(null); setSaved(false);
    try {
      const res = await fetch("/api/tenant", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: v.name,
          logoUrl: v.logoUrl || null,
          primaryColor: v.primaryColor,
          tagline: v.tagline || null,
          description: v.description || null,
          bookingHeadline: v.bookingHeadline || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.[0]?.message ?? data?.error ?? "Save failed");
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-5">
      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <Field label="Business name">
          <input value={v.name} onChange={(e) => update("name", e.target.value)} disabled={disabled} className="w-full rounded-md border px-3 py-2 text-sm disabled:bg-slate-50" />
        </Field>
        <Field label="Tagline" hint="One line under your name on the public page.">
          <input value={v.tagline} onChange={(e) => update("tagline", e.target.value)} disabled={disabled} className="w-full rounded-md border px-3 py-2 text-sm disabled:bg-slate-50" />
        </Field>
        <Field label="Description" hint="Long-form, shown below the tagline.">
          <textarea rows={4} value={v.description} onChange={(e) => update("description", e.target.value)} disabled={disabled} className="w-full rounded-md border px-3 py-2 text-sm disabled:bg-slate-50" />
        </Field>
        <Field label="Booking page headline" hint="Shown above the service list.">
          <input value={v.bookingHeadline} onChange={(e) => update("bookingHeadline", e.target.value)} disabled={disabled} className="w-full rounded-md border px-3 py-2 text-sm disabled:bg-slate-50" />
        </Field>
        <Field label="Logo URL" hint="A publicly hosted image URL (PNG or SVG).">
          <input type="url" value={v.logoUrl} onChange={(e) => update("logoUrl", e.target.value)} placeholder="https://…/logo.png" disabled={disabled} className="w-full rounded-md border px-3 py-2 text-sm disabled:bg-slate-50" />
        </Field>
        <Field label="Primary color">
          <div className="flex items-center gap-3">
            <input type="color" value={v.primaryColor} onChange={(e) => update("primaryColor", e.target.value)} disabled={disabled} className="h-10 w-14 cursor-pointer rounded border" />
            <input value={v.primaryColor} onChange={(e) => update("primaryColor", e.target.value)} disabled={disabled} className="w-32 rounded-md border px-3 py-2 font-mono text-sm" />
          </div>
        </Field>
      </div>

      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Preview</div>
        <div className="mt-3 rounded-lg border p-5" style={{ borderTop: `4px solid ${v.primaryColor}` }}>
          <div className="flex items-center gap-3">
            {v.logoUrl && (
              <img src={v.logoUrl} alt="" className="h-10 w-10 rounded object-contain" />
            )}
            <div>
              <div className="text-lg font-semibold">{v.name || "Your business"}</div>
              {v.tagline && <div className="text-sm text-slate-600">{v.tagline}</div>}
            </div>
          </div>
          {v.description && <p className="mt-3 text-sm text-slate-700">{v.description}</p>}
          {v.bookingHeadline && (
            <div className="mt-4 border-t pt-3 text-sm font-medium" style={{ color: v.primaryColor }}>
              {v.bookingHeadline}
            </div>
          )}
        </div>
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}
      {saved && <div className="text-sm text-green-700">Saved.</div>}

      <button
        onClick={save}
        disabled={busy || disabled}
        className="rounded-md bg-brand-accent px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save branding"}
      </button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <label className="block text-sm font-medium text-slate-700">{label}</label>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
      <div className="mt-1">{children}</div>
    </div>
  );
}
