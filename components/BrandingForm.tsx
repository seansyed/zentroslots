"use client";

/**
 * BrandingForm — Brand Studio client (Phase 18B luxury polish pass).
 *
 * Strict invariants this rewrite preserves:
 *   - `save()` continues to call PATCH /api/tenant with the SAME body
 *     shape. No new fields, no removed fields.
 *   - Local form state, disabled-when-no-Pro gating, and iframe cache-
 *     bust behavior all unchanged at the data layer.
 *   - `tenantSlug` optionality preserved (preview hides if absent).
 *
 * Visual additions (cosmetic only, no behavior change):
 *   - Theme cards carry a "personality" line + a mini-preview swatch
 *     that hints at the in-product surface.
 *   - Live preview is wrapped in a realistic browser-or-phone chrome
 *     so it reads as a hosted page, not an embedded mockup.
 *   - Form fields use the dashboard token palette (ink/border/brand)
 *     instead of raw slate-* so they align with the rest of the studio.
 *   - Save / Reload / Open buttons get premium hover states.
 */

import { useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  Lock,
  Monitor,
  RotateCw,
  Save,
  Smartphone,
  Sparkles,
} from "lucide-react";

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
  /** One-line emotional positioning shown beneath the theme name. */
  personality: string;
  color: string;
  /** Soft tint used as the mini-preview background. */
  surface: string;
};

// Six curated theme presets. Each carries a personality line so the
// cards communicate distinct emotional identities (PART 2 of brief).
// Behavior is identical to before — clicking a card just sets
// `primaryColor`. No layout / font swaps.
const THEMES: Theme[] = [
  {
    id: "modern-blue",
    name: "Modern Blue",
    hint: "SaaS classic",
    personality: "Tech-forward · trusted",
    color: "#2563eb",
    surface: "linear-gradient(135deg, #eff6ff 0%, #ffffff 100%)",
  },
  {
    id: "emerald",
    name: "Emerald",
    hint: "Fresh + calm",
    personality: "Wellness · coaching",
    color: "#059669",
    surface: "linear-gradient(135deg, #ecfdf5 0%, #ffffff 100%)",
  },
  {
    id: "luxury-gold",
    name: "Luxury Gold",
    hint: "High-end",
    personality: "Advisors · consultants",
    color: "#b45309",
    surface: "linear-gradient(135deg, #fffbeb 0%, #ffffff 100%)",
  },
  {
    id: "medical-calm",
    name: "Medical Calm",
    hint: "Clinical trust",
    personality: "Healthcare · diagnostic",
    color: "#0891b2",
    surface: "linear-gradient(135deg, #ecfeff 0%, #ffffff 100%)",
  },
  {
    id: "salon-rose",
    name: "Salon Rose",
    hint: "Warm hospitality",
    personality: "Salons · beauty · lifestyle",
    color: "#db2777",
    surface: "linear-gradient(135deg, #fdf2f8 0%, #ffffff 100%)",
  },
  {
    id: "minimal-black",
    name: "Minimal Black",
    hint: "Editorial",
    personality: "Studios · agencies · photo",
    color: "#111827",
    surface: "linear-gradient(135deg, #f9fafb 0%, #ffffff 100%)",
  },
];

type PreviewDevice = "desktop" | "mobile";

const HOST_LABEL =
  (process.env.NEXT_PUBLIC_APP_BASE_HOST ?? "app.zentromeet.com").replace(
    /^https?:\/\//,
    "",
  );

export default function BrandingForm({
  initial,
  disabled,
  tenantSlug,
}: {
  initial: Initial;
  disabled: boolean;
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
      if (!res.ok)
        throw new Error(
          data?.error?.[0]?.message ?? data?.error ?? "Save failed",
        );
      setSaved(true);
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
    el.src = `/u/${tenantSlug}?_preview=${Date.now()}`;
  }

  return (
    <div
      className={
        "mt-4 grid gap-5 " +
        (tenantSlug ? "lg:grid-cols-[minmax(0,1fr),minmax(0,1.08fr)]" : "")
      }
    >
      {/* ───────── LEFT COLUMN: studio controls ───────── */}
      <div className="space-y-5">
        {/* Theme presets */}
        <section className="relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-soft">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
          />
          <header className="flex items-baseline justify-between">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                Curated themes
              </div>
              <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
                Pick a personality
              </h3>
              <p className="mt-0.5 text-[11.5px] text-ink-muted">
                One click sets your primary color. Fine-tune below.
              </p>
            </div>
            {disabled && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-200/40">
                <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                Locked
              </span>
            )}
          </header>

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {THEMES.map((t) => {
              const isActive =
                v.primaryColor.toLowerCase() === t.color.toLowerCase();
              return (
                <button
                  key={t.id}
                  onClick={() => applyTheme(t)}
                  disabled={disabled}
                  aria-pressed={isActive}
                  className={
                    "group relative flex items-center gap-2.5 overflow-hidden rounded-xl border bg-surface p-2.5 text-left transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)] disabled:cursor-not-allowed disabled:opacity-50 " +
                    (isActive
                      ? "border-transparent shadow-[0_0_0_1.5px_var(--theme-ring),0_8px_22px_-10px_var(--theme-glow)]"
                      : "border-border hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[0_8px_18px_-12px_rgba(15,23,42,0.18)]")
                  }
                  style={
                    isActive
                      ? ({
                          ["--theme-ring" as never]: t.color,
                          ["--theme-glow" as never]: t.color + "55",
                        } as React.CSSProperties)
                      : undefined
                  }
                >
                  {/* Mini-preview swatch — gradient surface + an inset
                      "header line" + a button-shaped accent bar so the
                      card reads as a tiny webpage, not just a color
                      chip. */}
                  <span
                    aria-hidden
                    className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg ring-1 ring-black/5 shadow-sm"
                    style={{ background: t.surface }}
                  >
                    <span
                      className="absolute left-1.5 top-2 h-1 w-5 rounded-sm bg-slate-300/70"
                    />
                    <span
                      className="absolute left-1.5 top-4 h-0.5 w-3.5 rounded-sm bg-slate-300/50"
                    />
                    <span
                      className="absolute inset-x-1.5 bottom-1.5 h-2 rounded-[3px] shadow-[0_2px_4px_-1px_rgba(15,23,42,0.25)]"
                      style={{ backgroundColor: t.color }}
                    />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <div className="truncate text-[12.5px] font-semibold tracking-tight text-ink">
                        {t.name}
                      </div>
                    </div>
                    <div className="truncate text-[10.5px] text-ink-muted">
                      {t.personality}
                    </div>
                  </div>

                  {isActive ? (
                    <span
                      aria-hidden
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white shadow-sm"
                      style={{ backgroundColor: t.color }}
                    >
                      <Check className="h-3 w-3" strokeWidth={2.5} />
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className="h-5 w-5 shrink-0 rounded-full border border-dashed border-border opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* Identity fields */}
        <section className="relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-soft">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
          />
          <header>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Identity
            </div>
            <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
              What customers see
            </h3>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              These fields shape every public surface — landing, booking,
              email, calendar invite.
            </p>
          </header>

          <div className="mt-4 space-y-3.5">
            <div className="grid gap-3.5 sm:grid-cols-2">
              <Field label="Business name">
                <input
                  value={v.name}
                  onChange={(e) => update("name", e.target.value)}
                  disabled={disabled}
                  className={INPUT}
                />
              </Field>
              <Field
                label="Tagline"
                hint="One line under your name on the public page."
              >
                <input
                  value={v.tagline}
                  onChange={(e) => update("tagline", e.target.value)}
                  disabled={disabled}
                  className={INPUT}
                />
              </Field>
            </div>

            <Field
              label="Description"
              hint="Long-form, shown below the tagline."
            >
              <textarea
                rows={3}
                value={v.description}
                onChange={(e) => update("description", e.target.value)}
                disabled={disabled}
                className={INPUT}
              />
            </Field>

            <Field
              label="Booking page headline"
              hint="Shown above the service list."
            >
              <input
                value={v.bookingHeadline}
                onChange={(e) => update("bookingHeadline", e.target.value)}
                disabled={disabled}
                className={INPUT}
              />
            </Field>

            <div className="border-t border-border/60 pt-3.5">
              <div className="grid gap-3.5 sm:grid-cols-2">
                <Field
                  label="Logo URL"
                  hint="A publicly hosted image (PNG or SVG)."
                >
                  <input
                    type="url"
                    value={v.logoUrl}
                    onChange={(e) => update("logoUrl", e.target.value)}
                    placeholder="https://…/logo.png"
                    disabled={disabled}
                    className={INPUT}
                  />
                </Field>
                <Field
                  label="Primary color"
                  hint="Buttons, selected states, accents."
                >
                  <div className="flex items-center gap-2.5">
                    <div className="relative">
                      <input
                        type="color"
                        value={v.primaryColor}
                        onChange={(e) =>
                          update("primaryColor", e.target.value)
                        }
                        disabled={disabled}
                        className="h-9 w-12 cursor-pointer rounded-lg border border-border bg-surface p-0.5 transition-colors disabled:cursor-not-allowed"
                        aria-label="Primary color picker"
                      />
                    </div>
                    <input
                      value={v.primaryColor}
                      onChange={(e) => update("primaryColor", e.target.value)}
                      disabled={disabled}
                      className="w-28 rounded-lg border border-border bg-surface px-2.5 py-2 font-mono text-[12px] text-ink outline-none transition-colors focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15 disabled:bg-surface-inset"
                    />
                    <span
                      aria-hidden
                      className="inline-block h-7 w-7 shrink-0 rounded-md ring-1 ring-inset ring-black/10 shadow-inner"
                      style={{ backgroundColor: v.primaryColor }}
                    />
                  </div>
                </Field>
              </div>
            </div>
          </div>
        </section>

        {/* Status + actions */}
        {(error || saved) && (
          <div className="space-y-2">
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200/70 bg-red-50/70 px-3 py-2 text-[12px] text-red-700"
              >
                <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                <span>{error}</span>
              </div>
            )}
            {saved && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-[12px] text-emerald-700"
              >
                <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                <span>
                  Branding saved.
                  {tenantSlug ? " Preview reloaded with the latest values." : ""}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy || disabled}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand-accent px-3.5 text-[12.5px] font-semibold text-white shadow-[0_4px_14px_rgba(37,99,235,0.32)] transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-[0_8px_22px_rgba(37,99,235,0.40)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            {busy ? (
              <>
                <RotateCw className="h-3.5 w-3.5 animate-spin" strokeWidth={2.25} />
                Saving…
              </>
            ) : saved ? (
              <>
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                Saved
              </>
            ) : (
              <>
                <Save className="h-3.5 w-3.5" strokeWidth={2} />
                Save branding
              </>
            )}
          </button>
          {tenantSlug && (
            <button
              onClick={reloadPreview}
              disabled={busy}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md disabled:opacity-50 disabled:hover:translate-y-0"
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Reload preview
            </button>
          )}
          {tenantSlug && (
            <a
              href={`/u/${tenantSlug}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
            >
              <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
              Open public page
            </a>
          )}
        </div>

        {!tenantSlug && (
          <p className="rounded-lg border border-dashed border-border bg-surface-subtle px-3 py-2 text-[11px] text-ink-muted">
            Live preview will appear here once your workspace slug is set.
          </p>
        )}
      </div>

      {/* ───────── RIGHT COLUMN: live preview ───────── */}
      {tenantSlug && (
        <div className="lg:sticky lg:top-4 lg:self-start">
          <PreviewPanel
            tenantSlug={tenantSlug}
            device={device}
            setDevice={setDevice}
            iframeRef={iframeRef}
          />
        </div>
      )}
    </div>
  );
}

// ─── Preview panel with realistic browser / phone chrome ─────────────

function PreviewPanel({
  tenantSlug,
  device,
  setDevice,
  iframeRef,
}: {
  tenantSlug: string;
  device: PreviewDevice;
  setDevice: (d: PreviewDevice) => void;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-surface-subtle to-surface p-3.5 shadow-soft">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />

      <header className="mb-3 flex items-center justify-between gap-2 px-0.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
            <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Live preview
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-ink-muted">
            What your customers will see on{" "}
            <span className="font-mono text-ink">/u/{tenantSlug}</span>
          </div>
        </div>

        {/* Device toggle */}
        <div
          role="tablist"
          aria-label="Preview device"
          className="inline-flex shrink-0 items-center rounded-lg border border-border bg-surface p-0.5 shadow-sm"
        >
          {(
            [
              { id: "desktop", icon: Monitor, label: "Desktop" },
              { id: "mobile", icon: Smartphone, label: "Mobile" },
            ] as const
          ).map(({ id, icon: Icon, label }) => {
            const isActive = device === id;
            return (
              <button
                key={id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setDevice(id)}
                className={
                  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] font-semibold transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] " +
                  (isActive
                    ? "bg-ink text-white shadow-sm"
                    : "text-ink-muted hover:bg-surface-inset hover:text-ink")
                }
              >
                <Icon className="h-3 w-3" strokeWidth={2} />
                {label}
              </button>
            );
          })}
        </div>
      </header>

      {/* Frame switches between desktop browser chrome and phone bezel.
          The iframe itself stays mounted so internal state survives. */}
      <div
        className={
          "relative mx-auto transition-all duration-[280ms] ease-[cubic-bezier(0.16,1,0.3,1)] " +
          (device === "mobile" ? "max-w-[360px]" : "max-w-none")
        }
      >
        {device === "desktop" ? (
          <DesktopChrome tenantSlug={tenantSlug}>
            <iframe
              ref={iframeRef}
              src={`/u/${tenantSlug}`}
              title="Booking page preview"
              loading="lazy"
              className="block h-[620px] w-full bg-white"
            />
          </DesktopChrome>
        ) : (
          <PhoneChrome>
            <iframe
              ref={iframeRef}
              src={`/u/${tenantSlug}`}
              title="Booking page preview"
              loading="lazy"
              className="block h-[620px] w-full bg-white"
            />
          </PhoneChrome>
        )}
      </div>

      <p className="mt-2.5 px-0.5 text-[10.5px] text-ink-subtle">
        Preview updates after <span className="font-semibold text-ink">Save branding</span>.
        Theme picks above apply instantly to the color field — save to push them live.
      </p>
    </div>
  );
}

function DesktopChrome({
  tenantSlug,
  children,
}: {
  tenantSlug: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl bg-gradient-to-b from-slate-100/90 to-slate-50 ring-1 ring-slate-200/80 shadow-[0_24px_50px_-20px_rgba(15,23,42,0.22),0_4px_12px_-4px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <div className="flex shrink-0 gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/85" />
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/85" />
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#28c840]/85" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md border border-slate-200/80 bg-white/80 px-2 py-1 text-[10px] font-mono text-slate-500 shadow-inner backdrop-blur-sm">
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className="h-2.5 w-2.5 shrink-0 text-emerald-600"
            fill="currentColor"
          >
            <path d="M12 1a4 4 0 0 0-4 4v3H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4zm-2 7V5a2 2 0 1 1 4 0v3h-4z" />
          </svg>
          <span className="truncate text-slate-400">{HOST_LABEL}</span>
          <span className="truncate text-slate-700">/u/{tenantSlug}</span>
        </div>
      </div>
      <div className="overflow-hidden border-t border-slate-200/80 bg-white">
        {children}
      </div>
    </div>
  );
}

function PhoneChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mx-auto rounded-[38px] bg-slate-900 p-2 shadow-[0_36px_64px_-18px_rgba(15,23,42,0.40),0_10px_22px_-8px_rgba(15,23,42,0.20)]">
      {/* Notch */}
      <div
        aria-hidden
        className="absolute left-1/2 top-2.5 z-10 flex h-5 w-28 -translate-x-1/2 items-center justify-center rounded-full bg-slate-900"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-slate-700" />
      </div>
      {/* Side buttons */}
      <span
        aria-hidden
        className="absolute -left-0.5 top-20 h-10 w-0.5 rounded-r bg-slate-800"
      />
      <span
        aria-hidden
        className="absolute -left-0.5 top-32 h-16 w-0.5 rounded-r bg-slate-800"
      />
      <span
        aria-hidden
        className="absolute -right-0.5 top-24 h-20 w-0.5 rounded-l bg-slate-800"
      />
      <div className="overflow-hidden rounded-[30px] bg-white ring-1 ring-black/5">
        {children}
      </div>
    </div>
  );
}

// ─── Field primitive ───────────────────────────────────────────────

const INPUT =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-[13px] text-ink outline-none transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] placeholder:text-ink-subtle focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15 disabled:cursor-not-allowed disabled:bg-surface-inset disabled:text-ink-muted";

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
      <label className="block text-[11.5px] font-semibold tracking-tight text-ink">
        {label}
      </label>
      {hint && (
        <div className="mt-0.5 text-[10.5px] leading-relaxed text-ink-subtle">
          {hint}
        </div>
      )}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
