"use client";

import { useRef, useState } from "react";

type Initial = {
  name: string;
  logoUrl: string;
  primaryColor: string;
  tagline: string;
  description: string;
  bookingHeadline: string;
};

type Theme = {
  id: string;
  name: string;
  hint: string;
  color: string;
};

// Six curated theme presets. All real, accessible hex values — these
// just set `primaryColor`. We deliberately don't ship "luxury layouts"
// or font swaps yet; those would each be their own feature.
const THEMES: Theme[] = [
  { id: "modern-blue",   name: "Modern Blue",   hint: "SaaS classic",     color: "#2563eb" },
  { id: "emerald",       name: "Emerald",       hint: "Fresh + calm",     color: "#059669" },
  { id: "luxury-gold",   name: "Luxury Gold",   hint: "High-end",         color: "#b45309" },
  { id: "medical-calm",  name: "Medical Calm",  hint: "Clinical trust",   color: "#0891b2" },
  { id: "salon-rose",    name: "Salon Rose",    hint: "Warm hospitality", color: "#db2777" },
  { id: "minimal-black", name: "Minimal Black", hint: "Editorial",        color: "#111827" },
];

type PreviewDevice = "desktop" | "mobile";

export default function BrandingForm({
  initial,
  disabled,
  tenantSlug,
}: {
  initial: Initial;
  disabled: boolean;
  // Optional so the page.tsx fallback still works if not passed yet.
  // When omitted we hide the preview iframe.
  tenantSlug?: string;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  function update<K extends keyof Initial>(k: K, val: Initial[K]) {
    setSaved(false);
    setV((cur) => ({ ...cur, [k]: val }));
  }

  function applyTheme(t: Theme) {
    update("primaryColor", t.color);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
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
      // Force the preview iframe to refetch — it serves cached SSR HTML
      // from before the save, so a soft reload isn't enough.
      reloadPreview();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function reloadPreview() {
    const el = iframeRef.current;
    if (!el || !tenantSlug) return;
    // Cache-bust by setting src to itself with a fresh query param.
    el.src = `/u/${tenantSlug}?_preview=${Date.now()}`;
  }

  return (
    <div
      className={
        "mt-6 grid gap-6 " +
        (tenantSlug ? "lg:grid-cols-[minmax(0,1fr),minmax(0,1.05fr)]" : "")
      }
    >
      {/* ───────── LEFT COLUMN: studio controls ───────── */}
      <div className="space-y-5">
        {/* Theme presets */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-baseline justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Theme presets
              </div>
              <div className="mt-1 text-sm text-slate-700">
                One-click starting point. Fine-tune below.
              </div>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {THEMES.map((t) => {
              const isActive = v.primaryColor.toLowerCase() === t.color.toLowerCase();
              return (
                <button
                  key={t.id}
                  onClick={() => applyTheme(t)}
                  disabled={disabled}
                  className={
                    "group flex items-center gap-2 rounded-xl border bg-white p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-50 " +
                    (isActive
                      ? "border-slate-900 shadow-sm"
                      : "border-slate-200 hover:border-slate-300 hover:shadow-sm")
                  }
                >
                  <span
                    aria-hidden
                    className="h-7 w-7 shrink-0 rounded-md ring-1 ring-inset ring-black/10"
                    style={{ backgroundColor: t.color }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900">{t.name}</div>
                    <div className="truncate text-[11px] text-slate-500">{t.hint}</div>
                  </div>
                  {isActive && (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                      Active
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Identity fields */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Identity
          </div>
          <div className="mt-3 space-y-4">
            <Field label="Business name">
              <input
                value={v.name}
                onChange={(e) => update("name", e.target.value)}
                disabled={disabled}
                className={INPUT}
              />
            </Field>
            <Field label="Tagline" hint="One line under your name on the public page.">
              <input
                value={v.tagline}
                onChange={(e) => update("tagline", e.target.value)}
                disabled={disabled}
                className={INPUT}
              />
            </Field>
            <Field label="Description" hint="Long-form, shown below the tagline.">
              <textarea
                rows={3}
                value={v.description}
                onChange={(e) => update("description", e.target.value)}
                disabled={disabled}
                className={INPUT}
              />
            </Field>
            <Field label="Booking page headline" hint="Shown above the service list.">
              <input
                value={v.bookingHeadline}
                onChange={(e) => update("bookingHeadline", e.target.value)}
                disabled={disabled}
                className={INPUT}
              />
            </Field>
            <Field label="Logo URL" hint="A publicly hosted image URL (PNG or SVG).">
              <input
                type="url"
                value={v.logoUrl}
                onChange={(e) => update("logoUrl", e.target.value)}
                placeholder="https://…/logo.png"
                disabled={disabled}
                className={INPUT}
              />
            </Field>
            <Field label="Primary color" hint="Used on buttons, selected states, and accents.">
              <div className="flex items-center gap-3">
                <input
                  type="color"
                  value={v.primaryColor}
                  onChange={(e) => update("primaryColor", e.target.value)}
                  disabled={disabled}
                  className="h-10 w-14 cursor-pointer rounded-lg border border-slate-300 disabled:cursor-not-allowed"
                />
                <input
                  value={v.primaryColor}
                  onChange={(e) => update("primaryColor", e.target.value)}
                  disabled={disabled}
                  className="w-32 rounded-md border border-slate-300 px-3 py-2 font-mono text-sm disabled:bg-slate-50"
                />
                <span
                  aria-hidden
                  className="ml-2 inline-block h-6 w-6 rounded-md ring-1 ring-inset ring-black/10"
                  style={{ backgroundColor: v.primaryColor }}
                />
              </div>
            </Field>
          </div>
        </section>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        {saved && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            Saved.{tenantSlug ? " Preview reloaded." : ""}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={busy || disabled}
            className="inline-flex items-center justify-center rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save branding"}
          </button>
          {tenantSlug && (
            <button
              onClick={reloadPreview}
              disabled={busy}
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              ↻ Reload preview
            </button>
          )}
          {tenantSlug && (
            <a
              href={`/u/${tenantSlug}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
            >
              Open public page ↗
            </a>
          )}
        </div>
      </div>

      {/* ───────── RIGHT COLUMN: live preview (only when slug present) ───── */}
      {tenantSlug && (
        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between px-1">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Live preview · /u/{tenantSlug}
              </div>
              <div className="flex overflow-hidden rounded-md border border-slate-300 bg-white text-[11px]">
                {(["desktop", "mobile"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDevice(d)}
                    className={
                      "px-2.5 py-1 capitalize transition " +
                      (d === device ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50")
                    }
                    aria-pressed={d === device}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            {/* Device frame — desktop fills column; mobile clamps to 380px. */}
            <div
              className={
                "mx-auto overflow-hidden rounded-lg border border-slate-300 bg-white shadow-inner transition-all duration-300 " +
                (device === "mobile" ? "max-w-[380px]" : "w-full")
              }
            >
              <iframe
                ref={iframeRef}
                src={`/u/${tenantSlug}`}
                title="Booking page preview"
                loading="lazy"
                className="block h-[640px] w-full"
              />
            </div>
            <p className="mt-2 px-1 text-[11px] text-slate-500">
              Preview updates after you hit <b>Save branding</b>. Pick a theme preset above to test color changes quickly.
            </p>
          </div>
        </div>
      )}
    </div>
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
    <div>
      <label className="block text-xs font-medium text-slate-700">{label}</label>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
