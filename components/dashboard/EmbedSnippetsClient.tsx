"use client";

/**
 * Embed Widget Studio — Phase 16
 *
 * Premium generator for the public embed runtime (public/embed/v1.js):
 *   - 4 widget types: Inline · Popup · Floating · Full-page
 *   - Live preview pane with desktop + mobile toggle
 *   - Appearance controls (color, radius, compact, hide header)
 *   - Behavior controls (preselect service, auto-open, hide branding)
 *   - Install tabs: HTML · React · Next.js · WordPress · Webflow
 *   - QR code generator + UTM source/medium/campaign
 *
 * Honest discipline:
 *   - No fake metrics
 *   - All snippets use the production /embed/v1.js runtime
 *   - White-label gating respects tenant plan (server-passed)
 *   - Multiple widgets coexist (script is idempotent)
 */

import * as React from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Globe,
  Layers,
  Link2,
  Monitor,
  MousePointerClick,
  PanelTop,
  Play,
  QrCode,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { PremiumCard } from "@/components/ui/Card";
import { toast } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

// ─── Types ────────────────────────────────────────────────────────

type Service = { id: string; name: string; slug: string; hasStaff: boolean };
type WidgetMode = "inline" | "popup" | "floating" | "fullpage";
type Framework = "html" | "react" | "nextjs" | "wordpress" | "webflow";

type EmbedConfig = {
  mode: WidgetMode;
  serviceSlug: string;
  color: string;
  radius: number;
  compact: boolean;
  hideHeader: boolean;
  hideBranding: boolean;
  buttonLabel: string;
  position: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  autoOpen: boolean;
  autoOpenDelayMs: number;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  successRedirect: string;
  minHeight: number;
};

// ─── Component ───────────────────────────────────────────────────

export default function EmbedSnippetsClient({
  baseUrl,
  tenantSlug,
  tenantPrimaryColor,
  services,
  canHideBranding,
  planName,
}: {
  baseUrl: string;
  tenantSlug: string;
  tenantPrimaryColor: string;
  services: Service[];
  canHideBranding: boolean;
  planName: string;
}) {
  const firstWithStaff = services.find((s) => s.hasStaff) ?? services[0];

  const [cfg, setCfg] = React.useState<EmbedConfig>({
    mode: "inline",
    serviceSlug: firstWithStaff?.slug ?? "",
    color: tenantPrimaryColor || "#2563EB",
    radius: 12,
    compact: false,
    hideHeader: false,
    hideBranding: false,
    buttonLabel: "Book a meeting",
    position: "bottom-right",
    autoOpen: false,
    autoOpenDelayMs: 5000,
    utmSource: "",
    utmMedium: "embed",
    utmCampaign: "",
    successRedirect: "",
    minHeight: 720,
  });
  const [device, setDevice] = React.useState<"desktop" | "mobile">("desktop");
  const [framework, setFramework] = React.useState<Framework>("html");

  function update<K extends keyof EmbedConfig>(key: K, value: EmbedConfig[K]) {
    setCfg((cur) => ({ ...cur, [key]: value }));
  }

  const selectedService = services.find((s) => s.slug === cfg.serviceSlug) ?? null;
  const selectedHasStaff = selectedService?.hasStaff ?? false;
  const previewUrl = buildEmbedUrl(baseUrl, tenantSlug, cfg);
  const directLink = buildDirectLink(baseUrl, tenantSlug, cfg);

  const snippet = React.useMemo(
    () => buildSnippet(framework, baseUrl, tenantSlug, cfg, canHideBranding),
    [framework, baseUrl, tenantSlug, cfg, canHideBranding],
  );

  // Sandbox URL points to /embed/demo with the current widget config —
  // the demo page loads the real /embed/v1.js runtime and mounts the
  // widget exactly the way it would on a customer site (Phase 16C).
  const sandboxUrl = React.useMemo(() => {
    const q = new URLSearchParams();
    q.set("tenant", tenantSlug);
    if (cfg.serviceSlug) q.set("service", cfg.serviceSlug);
    q.set("mode", cfg.mode === "fullpage" ? "inline" : cfg.mode);
    q.set("color", cfg.color);
    q.set("label", cfg.buttonLabel);
    q.set("radius", String(cfg.radius));
    return `${baseUrl}/embed/demo?${q.toString()}`;
  }, [baseUrl, tenantSlug, cfg]);

  if (services.length === 0) {
    return (
      <div className="mx-auto mt-3 max-w-[1180px] space-y-4">
        <StudioHero
          mode={cfg.mode}
          canHideBranding={canHideBranding}
          planName={planName}
        />
        <EmbedEmptyState />
      </div>
    );
  }

  return (
    <div className="mx-auto mt-3 max-w-[1180px] space-y-4">
      <StudioHero
        mode={cfg.mode}
        canHideBranding={canHideBranding}
        planName={planName}
      />

      <ModeSelector mode={cfg.mode} onChange={(m) => update("mode", m)} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),minmax(0,1.15fr)]">
        <div className="space-y-4">
          <PremiumCard className="relative overflow-hidden p-4">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
            <SectionHeader eyebrow="Step 1 · target" title="What does this widget book?" icon={Layers} />
            <div className="mt-3 grid gap-2">
              <select
                value={cfg.serviceSlug}
                onChange={(e) => update("serviceSlug", e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12px] text-ink outline-none transition-all focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15"
              >
                {services.length === 0 && (
                  <option value="">No services yet — create one first</option>
                )}
                {services.map((s) => (
                  <option key={s.id} value={s.slug}>
                    {s.name} {!s.hasStaff ? "· no staff" : ""}
                  </option>
                ))}
              </select>
              {selectedService && !selectedHasStaff && (
                <div className="rounded-lg border border-amber-200/60 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-800">
                  <span className="font-semibold">Heads-up:</span> this service has no staff assigned. The embed will render a friendly &quot;not bookable&quot; message until a host is added.
                </div>
              )}
            </div>
          </PremiumCard>

          <PremiumCard className="relative overflow-hidden p-4">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
            <SectionHeader eyebrow="Step 2 · appearance" title="Match your brand" icon={Eye} />

            {/* Preset chips — one-click style starters */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">Presets:</span>
              {APPEARANCE_PRESETS.map((p) => {
                const applied =
                  cfg.radius === p.radius &&
                  cfg.compact === p.compact &&
                  cfg.hideHeader === p.hideHeader;
                return (
                  <button
                    key={p.name}
                    type="button"
                    onClick={() => setCfg((cur) => ({ ...cur, radius: p.radius, compact: p.compact, hideHeader: p.hideHeader }))}
                    aria-pressed={applied}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px",
                      applied
                        ? "bg-brand-accent text-white ring-brand-accent shadow-[0_2px_8px_-2px_rgba(37,99,235,0.40),inset_0_1px_0_rgba(255,255,255,0.18)]"
                        : "bg-surface text-ink-muted ring-border/60 hover:bg-brand-subtle hover:text-brand-accent hover:ring-brand-accent/30",
                    )}
                  >
                    {applied && <Check className="h-2.5 w-2.5" strokeWidth={2.75} />}
                    {p.name}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Accent color">
                <div className="flex items-center gap-2">
                  <input type="color" value={cfg.color} onChange={(e) => update("color", e.target.value)} className="h-9 w-12 cursor-pointer rounded-lg border border-border bg-surface p-0.5" />
                  <input type="text" value={cfg.color} onChange={(e) => update("color", e.target.value)} className="w-28 rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15" />
                </div>
              </Field>
              <Field label={`Radius · ${cfg.radius}px`}>
                <input type="range" min={0} max={28} step={1} value={cfg.radius} onChange={(e) => update("radius", parseInt(e.target.value, 10))} className="w-full accent-brand-accent" />
              </Field>
              {(cfg.mode === "inline" || cfg.mode === "popup") && (
                <Field label={`Height · ${cfg.minHeight}px`}>
                  <input type="range" min={480} max={920} step={20} value={cfg.minHeight} onChange={(e) => update("minHeight", parseInt(e.target.value, 10))} className="w-full accent-brand-accent" />
                </Field>
              )}
              {(cfg.mode === "popup" || cfg.mode === "floating") && (
                <Field label="Button label">
                  <input type="text" value={cfg.buttonLabel} onChange={(e) => update("buttonLabel", e.target.value)} maxLength={48} className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15" />
                </Field>
              )}
              {cfg.mode === "floating" && (
                <Field label="Position">
                  <select value={cfg.position} onChange={(e) => update("position", e.target.value as EmbedConfig["position"])} className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15">
                    <option value="bottom-right">Bottom right</option>
                    <option value="bottom-left">Bottom left</option>
                    <option value="top-right">Top right</option>
                    <option value="top-left">Top left</option>
                  </select>
                </Field>
              )}
            </div>
            <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
              <Toggle checked={cfg.compact} onChange={(v) => update("compact", v)} label="Compact spacing" sub="Tighter padding · denser slots" />
              <Toggle checked={cfg.hideHeader} onChange={(v) => update("hideHeader", v)} label="Hide tenant header" sub="Best for popup mode" />
              <Toggle checked={cfg.hideBranding && canHideBranding} onChange={(v) => update("hideBranding", v)} label="Hide ZentroMeet branding" sub={canHideBranding ? "Pro plan · white-label" : "Pro plan only · upgrade to enable"} disabled={!canHideBranding} lock={!canHideBranding} />
              {cfg.mode === "floating" && (
                <Toggle checked={cfg.autoOpen} onChange={(v) => update("autoOpen", v)} label="Auto-open" sub={`Opens after ${cfg.autoOpenDelayMs}ms`} />
              )}
            </div>
          </PremiumCard>

          <PremiumCard className="relative overflow-hidden p-4">
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
            <SectionHeader eyebrow="Step 3 · tracking" title="UTM + analytics" icon={Sparkles} />
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <Field label="utm_source"><input value={cfg.utmSource} onChange={(e) => update("utmSource", e.target.value.toLowerCase().replace(/\s+/g, "-"))} placeholder="acme-site" className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15" /></Field>
              <Field label="utm_medium"><input value={cfg.utmMedium} onChange={(e) => update("utmMedium", e.target.value.toLowerCase().replace(/\s+/g, "-"))} placeholder="embed" className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15" /></Field>
              <Field label="utm_campaign"><input value={cfg.utmCampaign} onChange={(e) => update("utmCampaign", e.target.value.toLowerCase().replace(/\s+/g, "-"))} placeholder="q3-launch" className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15" /></Field>
            </div>
          </PremiumCard>
        </div>

        <PreviewPane previewUrl={previewUrl} directLink={directLink} device={device} setDevice={setDevice} mode={cfg.mode} color={cfg.color} buttonLabel={cfg.buttonLabel} radius={cfg.radius} minHeight={cfg.minHeight} />
      </div>

      <InstallCard
        framework={framework}
        setFramework={setFramework}
        snippet={snippet}
        directLink={directLink}
        previewUrl={previewUrl}
        sandboxUrl={sandboxUrl}
        mode={cfg.mode}
      />

      <EmbedTrustStrip />

      <DirectLinkCard directLink={directLink} />
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────

function StudioHero({ mode, canHideBranding, planName }: { mode: WidgetMode; canHideBranding: boolean; planName: string }) {
  const modeName = MODE_META[mode].title;
  return (
    <PremiumCard compact interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface">
      <span aria-hidden className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/15 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.18] blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-brand-accent">
            <Code2 className="h-3 w-3" strokeWidth={2} />
            Embed Widget Studio
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">Take bookings from any website</h1>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-muted">
            Drop a single <code className="rounded bg-surface-inset px-1 py-px font-mono text-[11px] text-ink">{`<script>`}</code> on your site to embed the booking flow inline, as a popup, or as a floating button. All snippets use the production runtime at <code className="rounded bg-surface-inset px-1 py-px font-mono text-[11px] text-ink">/embed/v1.js</code> — versioned, cached at the edge, idempotent.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-emerald-700 ring-1 ring-emerald-200/50">
              <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
              Live · {modeName}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
              <Sparkles className="h-2.5 w-2.5" strokeWidth={2} />
              {canHideBranding ? `White-label · ${planName}` : `Branded · ${planName}`}
            </span>
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Mode selector ──────────────────────────────────────────────

type ModeBadge = { label: string; tone: "emerald" | "violet" | "indigo" };

/** One-click style starters. Each applies a radius + density combo. */
const APPEARANCE_PRESETS: { name: string; radius: number; compact: boolean; hideHeader: boolean }[] = [
  { name: "Rounded",    radius: 16, compact: false, hideHeader: false },
  { name: "Sharp",      radius: 0,  compact: false, hideHeader: false },
  { name: "Soft SaaS",  radius: 12, compact: false, hideHeader: false },
  { name: "Enterprise", radius: 6,  compact: true,  hideHeader: false },
  { name: "Minimal",    radius: 8,  compact: true,  hideHeader: true  },
];

const MODE_META: Record<
  WidgetMode,
  { title: string; icon: LucideIcon; sub: string; badge?: ModeBadge }
> = {
  inline: { title: "Inline embed", icon: PanelTop, sub: "Iframe inside your page", badge: { label: "Recommended", tone: "emerald" } },
  popup: { title: "Popup modal", icon: MousePointerClick, sub: "Click a button → modal opens", badge: { label: "Most popular", tone: "violet" } },
  floating: { title: "Floating button", icon: ArrowUpRight, sub: "Bottom-right launcher on every page" },
  fullpage: { title: "Full-page", icon: ExternalLink, sub: "Direct link · white-label microsite", badge: { label: "Enterprise", tone: "indigo" } },
};

function ModeSelector({ mode, onChange }: { mode: WidgetMode; onChange: (m: WidgetMode) => void }) {
  const order: WidgetMode[] = ["inline", "popup", "floating", "fullpage"];
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {order.map((m) => {
        const meta = MODE_META[m];
        const Icon = meta.icon;
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={active}
            className={cn(
              "group relative overflow-hidden rounded-2xl border p-3.5 text-left transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              active
                ? "border-brand-accent bg-gradient-to-br from-brand-subtle/55 via-surface to-surface ring-2 ring-brand-accent/15 ring-offset-1 ring-offset-surface shadow-[0_1px_2px_rgba(15,23,42,0.06),0_8px_22px_-8px_rgba(37,99,235,0.30),inset_0_1px_0_rgba(255,255,255,0.70)]"
                : "border-border/70 bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.45)] hover:-translate-y-px hover:border-border hover:shadow-[0_6px_16px_-10px_rgba(15,23,42,0.16)]",
            )}
          >
            <div className="flex items-start gap-2.5">
              <span className={cn("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ring-1 transition-transform duration-200 group-hover:scale-105", active ? "bg-brand-accent text-white ring-brand-accent/30 shadow-[0_2px_8px_-2px_rgba(37,99,235,0.40),inset_0_1px_0_rgba(255,255,255,0.22)]" : "bg-gradient-to-br from-brand-subtle to-surface text-brand-accent ring-brand-accent/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]")}>
                <Icon className="h-4 w-4" strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-semibold tracking-tight text-ink">{meta.title}</span>
                  {active && (
                    <span aria-hidden className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand-accent text-white">
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[10.5px] leading-tight text-ink-muted">{meta.sub}</p>
                {meta.badge && (
                  <span
                    className={cn(
                      "mt-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.10em] ring-1",
                      meta.badge.tone === "emerald" && "bg-gradient-to-b from-emerald-50 to-emerald-100/55 text-emerald-700 ring-emerald-200/55",
                      meta.badge.tone === "violet" && "bg-gradient-to-b from-violet-50 to-violet-100/55 text-violet-700 ring-violet-200/55",
                      meta.badge.tone === "indigo" && "bg-gradient-to-b from-indigo-50 to-indigo-100/55 text-indigo-700 ring-indigo-200/55",
                    )}
                  >
                    {meta.badge.tone === "violet" ? (
                      <Sparkles className="h-2 w-2" strokeWidth={2.5} />
                    ) : (
                      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
                    )}
                    {meta.badge.label}
                  </span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Preview pane ───────────────────────────────────────────────

function PreviewPane({ previewUrl, directLink, device, setDevice, mode, color, buttonLabel, radius, minHeight }: { previewUrl: string; directLink: string; device: "desktop" | "mobile"; setDevice: (d: "desktop" | "mobile") => void; mode: WidgetMode; color: string; buttonLabel: string; radius: number; minHeight: number }) {
  return (
    <PremiumCard className="relative overflow-hidden p-3.5 lg:sticky lg:top-4 lg:self-start">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <header className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-accent">
            <Eye className="h-3 w-3" strokeWidth={2} />
            Live preview
          </div>
          <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">What customers see</h3>
        </div>
        <div role="tablist" aria-label="Preview device" className="inline-flex shrink-0 items-center rounded-lg border border-border bg-surface p-0.5 shadow-sm">
          {([{ id: "desktop", icon: Monitor, label: "Desktop" }, { id: "mobile", icon: Smartphone, label: "Mobile" }] as const).map(({ id, icon: Icon, label }) => {
            const active = device === id;
            return (
              <button key={id} type="button" role="tab" aria-selected={active} onClick={() => setDevice(id)} className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] font-semibold transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]", active ? "bg-ink text-white shadow-sm" : "text-ink-muted hover:bg-surface-inset hover:text-ink")}>
                <Icon className="h-3 w-3" strokeWidth={2} />
                {label}
              </button>
            );
          })}
        </div>
      </header>

      <div className={cn(
        "relative mx-auto transition-all duration-[320ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        device === "mobile" ? "max-w-[360px]" : "max-w-none",
      )}>
        {/* Soft brand edge glow behind active preview canvas */}
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-2 -z-10 rounded-3xl bg-gradient-to-br from-brand-accent/[0.06] via-transparent to-emerald-200/[0.06] blur-2xl"
        />
        {mode === "inline" && (
          device === "mobile" ? (
            <PhoneChrome>
              <PreviewIframe
                src={previewUrl}
                title="Inline embed preview"
                height={620}
                radius={0}
              />
            </PhoneChrome>
          ) : (
            <BrowserChrome>
              <PreviewIframe
                src={previewUrl}
                title="Inline embed preview"
                height={Math.min(Math.max(minHeight, 560), 680)}
                radius={radius}
              />
            </BrowserChrome>
          )
        )}
        {mode === "popup" && (
          <BrowserChrome>
            <div className="flex h-[440px] items-center justify-center bg-gradient-to-br from-slate-50 to-white p-6">
              <div className="text-center">
                <p className="text-[12px] text-ink-muted">Customer&rsquo;s website content…</p>
                <button type="button" className="mt-4 inline-flex h-10 items-center gap-1.5 rounded-lg px-4 text-[13px] font-semibold text-white shadow-[0_4px_14px_-2px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.16)] transition-transform hover:-translate-y-px" style={{ background: color }}>
                  {buttonLabel}
                  <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
                </button>
                <p className="mt-3 text-[10.5px] text-ink-subtle">Click → modal opens with the booking iframe</p>
              </div>
            </div>
          </BrowserChrome>
        )}
        {mode === "floating" && (
          <BrowserChrome>
            <div className="relative h-[480px] bg-gradient-to-br from-slate-50 to-white p-6">
              <p className="text-[12px] text-ink-muted">Customer&rsquo;s website content…</p>
              <div className="mt-2 space-y-2">
                {[80, 65, 72, 58, 80, 62].map((w, i) => (
                  <div key={i} className="h-2 rounded-full bg-slate-200/70" style={{ width: `${w}%` }} />
                ))}
              </div>
              {/* Idle pulse + launcher */}
              <div className="absolute bottom-4 right-4">
                <span
                  aria-hidden
                  className="absolute inset-0 -m-1 rounded-full blur-md"
                  style={{ background: color, opacity: 0.32, animation: "zmFloatingPulse 2.6s cubic-bezier(0.16,1,0.3,1) infinite" }}
                />
                <div
                  className="relative inline-flex items-center gap-2 rounded-full px-3.5 py-2.5 text-[12.5px] font-semibold text-white shadow-[0_8px_22px_-4px_rgba(15,23,42,0.30),inset_0_1px_0_rgba(255,255,255,0.16)]"
                  style={{ background: color }}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>
                  {buttonLabel}
                </div>
              </div>
              <style jsx>{`
                @keyframes zmFloatingPulse {
                  0%, 100% { transform: scale(1); opacity: 0.32; }
                  50%      { transform: scale(1.18); opacity: 0.14; }
                }
              `}</style>
            </div>
          </BrowserChrome>
        )}
        {mode === "fullpage" && (
          <BrowserChrome url={directLink}>
            <PreviewIframe
              src={previewUrl}
              title="Full-page preview"
              height={480}
              radius={0}
            />
          </BrowserChrome>
        )}
      </div>

      <p className="mt-2.5 px-0.5 text-[10.5px] text-ink-subtle">Preview reflects live appearance + behavior settings. Tracking + UTM are applied at runtime, not in this preview.</p>
    </PremiumCard>
  );
}

function BrowserChrome({ children, url }: { children: React.ReactNode; url?: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-gradient-to-b from-slate-100/90 to-slate-50 ring-1 ring-slate-200/80 shadow-[0_24px_50px_-20px_rgba(15,23,42,0.22),0_4px_12px_-4px_rgba(15,23,42,0.08)]">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <div className="flex shrink-0 gap-1">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/85" />
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/85" />
          <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-[#28c840]/85" />
        </div>
        <div className="ml-1 flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md border border-slate-200/80 bg-white/80 px-2 py-1 font-mono text-[10px] text-slate-500 backdrop-blur-sm">
          <svg aria-hidden viewBox="0 0 24 24" className="h-2.5 w-2.5 shrink-0 text-emerald-600" fill="currentColor"><path d="M12 1a4 4 0 0 0-4 4v3H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4zm-2 7V5a2 2 0 1 1 4 0v3h-4z" /></svg>
          <span className="truncate">{url ?? "yoursite.com — embed preview"}</span>
        </div>
      </div>
      <div className="overflow-hidden border-t border-slate-200/80 bg-white">{children}</div>
    </div>
  );
}

/** Realistic mobile bezel — matches the Brand Studio phone preview. */
function PhoneChrome({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative mx-auto rounded-[36px] bg-slate-900 p-2 shadow-[0_36px_64px_-18px_rgba(15,23,42,0.40),0_10px_22px_-8px_rgba(15,23,42,0.20)]">
      <div
        aria-hidden
        className="absolute left-1/2 top-2.5 z-10 flex h-5 w-28 -translate-x-1/2 items-center justify-center rounded-full bg-slate-900"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-slate-700" />
      </div>
      <span aria-hidden className="absolute -left-0.5 top-20 h-10 w-0.5 rounded-r bg-slate-800" />
      <span aria-hidden className="absolute -left-0.5 top-32 h-16 w-0.5 rounded-r bg-slate-800" />
      <span aria-hidden className="absolute -right-0.5 top-24 h-20 w-0.5 rounded-l bg-slate-800" />
      <div className="overflow-hidden rounded-[28px] bg-white ring-1 ring-black/5">
        {children}
      </div>
    </div>
  );
}

// ─── Install card ──────────────────────────────────────────────

const FRAMEWORK_LABELS: Record<Framework, string> = { html: "HTML", react: "React", nextjs: "Next.js", wordpress: "WordPress", webflow: "Webflow" };
const FRAMEWORK_DIFFICULTY: Record<Framework, "easy" | "medium" | "advanced"> = {
  html: "easy",
  react: "medium",
  nextjs: "medium",
  wordpress: "easy",
  webflow: "easy",
};

function InstallCard({ framework, setFramework, snippet, directLink, previewUrl, sandboxUrl, mode }: { framework: Framework; setFramework: (f: Framework) => void; snippet: string; directLink: string; previewUrl: string; sandboxUrl: string; mode: WidgetMode }) {
  const [copied, setCopied] = React.useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast("Snippet copied to clipboard", "success");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copy failed — select manually", "error");
    }
  }
  return (
    <PremiumCard className="relative overflow-hidden p-4 sm:p-5">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-accent">
              <Code2 className="h-3 w-3" strokeWidth={2} />
              Install snippet
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-gradient-to-b from-emerald-50 to-emerald-100/55 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.10em] text-emerald-700 ring-1 ring-emerald-200/55">
              <Zap className="h-2 w-2" strokeWidth={2.75} />
              Live in under 60 s
            </span>
          </div>
          <h3 className="mt-1 text-[15px] font-semibold tracking-tight text-ink">Paste this into your site</h3>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">Production-ready. Cached at the edge. Works on any framework.</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/* Sandbox: mounts the real /embed/v1.js runtime in the chosen mode */}
          <a
            href={sandboxUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group/sb inline-flex h-8 items-center gap-1.5 rounded-md bg-gradient-to-b from-brand-accent to-brand-hover px-2.5 text-[11.5px] font-semibold text-white shadow-[0_2px_8px_-2px_rgba(37,99,235,0.30),inset_0_1px_0_rgba(255,255,255,0.18)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:shadow-[0_6px_18px_-4px_rgba(37,99,235,0.42)]"
          >
            <Play className="h-3 w-3" strokeWidth={2} />
            {mode === "popup" ? "Test popup" : mode === "floating" ? "Test floating button" : mode === "inline" ? "Open live sandbox" : "Open preview"}
            <ArrowRight className="h-3 w-3 transition-transform duration-[220ms] group-hover/sb:translate-x-0.5" strokeWidth={2.25} />
          </a>
          {/* Iframe-only preview (no runtime — just the embed page itself) */}
          <a
            href={previewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[11.5px] font-semibold text-ink shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all duration-[220ms] hover:-translate-y-px hover:border-border-strong hover:shadow-[0_4px_12px_-6px_rgba(15,23,42,0.18)]"
          >
            <Eye className="h-3 w-3" strokeWidth={2} />
            Iframe only
          </a>
          <a
            href={directLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[11.5px] font-semibold text-ink shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all duration-[220ms] hover:-translate-y-px hover:border-border-strong hover:shadow-[0_4px_12px_-6px_rgba(15,23,42,0.18)]"
          >
            <ExternalLink className="h-3 w-3" strokeWidth={2} />
            Direct link
          </a>
        </div>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-sm">
          {(Object.keys(FRAMEWORK_LABELS) as Framework[]).map((f) => {
            const active = framework === f;
            return (
              <button key={f} type="button" onClick={() => setFramework(f)} className={cn("inline-flex h-7 items-center rounded-md px-2.5 text-[11px] font-semibold transition-all duration-[180ms]", active ? "bg-ink text-white shadow-sm" : "text-ink-muted hover:bg-surface-inset hover:text-ink")}>
                {FRAMEWORK_LABELS[f]}
              </button>
            );
          })}
        </div>
        <DifficultyBadge level={FRAMEWORK_DIFFICULTY[framework]} />
      </div>

      <div className="mt-3 overflow-hidden rounded-xl bg-[#0b1220] shadow-[0_4px_14px_-6px_rgba(15,23,42,0.30)]">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-[0.10em] text-slate-400">{FRAMEWORK_LABELS[framework]}</span>
          </div>
          <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white">
            {copied ? <Check className="h-3 w-3" strokeWidth={2.25} /> : <Copy className="h-3 w-3" strokeWidth={2.25} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <pre className="max-h-[460px] overflow-auto px-3 py-3 font-mono text-[11.5px] leading-[1.55] text-slate-200">
          <code>{snippet}</code>
        </pre>
      </div>

      <p className="mt-2 text-[10.5px] text-ink-subtle">
        Direct booking URL: <a href={directLink} target="_blank" rel="noopener noreferrer" className="font-mono text-brand-accent hover:underline">{directLink}</a>
      </p>
    </PremiumCard>
  );
}

function DifficultyBadge({ level }: { level: "easy" | "medium" | "advanced" }) {
  const meta =
    level === "easy"
      ? { label: "1-line install", cls: "bg-gradient-to-b from-emerald-50 to-emerald-100/55 text-emerald-700 ring-emerald-200/55" }
      : level === "medium"
        ? { label: "Component + hook", cls: "bg-gradient-to-b from-blue-50 to-blue-100/55 text-blue-700 ring-blue-200/55" }
        : { label: "Advanced", cls: "bg-gradient-to-b from-violet-50 to-violet-100/55 text-violet-700 ring-violet-200/55" };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.10em] ring-1", meta.cls)}>
      <Zap className="h-2.5 w-2.5" strokeWidth={2.5} />
      {meta.label}
    </span>
  );
}

// ─── Direct link + QR card ─────────────────────────────────────

function DirectLinkCard({ directLink }: { directLink: string }) {
  const [showQr, setShowQr] = React.useState(false);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(directLink)}&margin=8`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(directLink);
      toast("Direct link copied", "success");
    } catch {
      toast("Copy failed", "error");
    }
  }

  return (
    <PremiumCard className="relative overflow-hidden p-4">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-accent">
            <Link2 className="h-3 w-3" strokeWidth={2} />
            Direct booking link
          </div>
          <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Share the booking URL anywhere</h3>
          <p className="mt-0.5 text-[11.5px] text-ink-muted">Works in email signatures, SMS, QR codes, social bios.</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface-inset px-3 py-2 font-mono text-[12px] text-ink">{directLink}</code>
            <button type="button" onClick={copyLink} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-semibold text-ink shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all hover:-translate-y-px hover:border-border-strong hover:shadow-md">
              <Copy className="h-3.5 w-3.5" strokeWidth={2} />
              Copy
            </button>
            <button type="button" onClick={() => setShowQr((x) => !x)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-semibold text-ink shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all hover:-translate-y-px hover:border-border-strong hover:shadow-md">
              <QrCode className="h-3.5 w-3.5" strokeWidth={2} />
              {showQr ? "Hide QR" : "Show QR"}
              <ChevronDown className={cn("h-3 w-3 transition-transform", showQr ? "rotate-180" : "")} strokeWidth={2} />
            </button>
          </div>

          {showQr && (
            <div className="mt-3 inline-flex flex-col items-center gap-2 rounded-2xl border border-border/65 bg-gradient-to-b from-white via-white to-slate-50 p-5 shadow-[0_8px_24px_-8px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.75)]">
              <div className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-accent">
                Scan to book instantly
              </div>
              <div className="rounded-xl bg-white p-2 ring-1 ring-border/40 shadow-[0_2px_8px_-2px_rgba(15,23,42,0.10)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrUrl} alt="Booking QR" width={220} height={220} className="block" />
              </div>
              <p className="max-w-[220px] text-center text-[10.5px] leading-relaxed text-ink-subtle">
                Open any phone camera, point it at this code, and the booking flow opens directly.
              </p>
              <div className="mt-1 flex items-center gap-1.5">
                <a
                  href={qrUrl}
                  download="zentromeet-booking-qr.png"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-gradient-to-b from-brand-accent to-brand-hover px-2.5 text-[11.5px] font-semibold text-white shadow-[0_2px_8px_-2px_rgba(37,99,235,0.30),inset_0_1px_0_rgba(255,255,255,0.18)] transition-all duration-[220ms] hover:-translate-y-px hover:shadow-[0_6px_18px_-4px_rgba(37,99,235,0.42)]"
                >
                  <Download className="h-3 w-3" strokeWidth={2} />
                  Download PNG
                </a>
                <a
                  href={qrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 text-[11.5px] font-semibold text-ink shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all duration-[220ms] hover:-translate-y-px hover:border-border-strong hover:shadow-md"
                >
                  <ExternalLink className="h-3 w-3" strokeWidth={2} />
                  Open
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Primitives ────────────────────────────────────────────────

function SectionHeader({ eyebrow, title, icon: Icon }: { eyebrow: string; title: string; icon: LucideIcon }) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-subtle text-brand-accent ring-1 ring-brand-accent/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
        <span className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-accent">{eyebrow}</span>
      </div>
      <h3 className="mt-1.5 text-[14.5px] font-semibold leading-[1.2] tracking-tight text-ink">{title}</h3>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Toggle({ checked, onChange, label, sub, disabled, lock }: { checked: boolean; onChange: (v: boolean) => void; label: string; sub: string; disabled?: boolean; lock?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => !disabled && onChange(!checked)} disabled={disabled} className={cn("group flex items-center gap-2.5 rounded-lg border border-border/65 bg-surface p-2 text-left shadow-[0_1px_2px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.45)] transition-all duration-[200ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:border-border hover:shadow-md", disabled && "cursor-not-allowed opacity-60 hover:translate-y-0")}>
      <span className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200", checked ? "bg-brand-accent shadow-[inset_0_1px_2px_rgba(15,23,42,0.10),0_0_0_3px_rgba(37,99,235,0.16)]" : "bg-surface-inset ring-1 ring-border/70")}>
        <span aria-hidden className={cn("inline-block h-4 w-4 transform rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.22),inset_0_0.5px_0_rgba(255,255,255,0.65)] transition-transform duration-200", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] font-semibold tracking-tight text-ink">{label} {lock && <span aria-hidden className="ml-0.5 text-amber-600">·</span>}</span>
        <span className="block text-[10px] leading-tight text-ink-muted">{sub}</span>
      </span>
    </button>
  );
}

// ─── Snippet generators ────────────────────────────────────────

function buildEmbedUrl(baseUrl: string, slug: string, cfg: EmbedConfig): string {
  const path = cfg.serviceSlug ? `/embed/${slug}/${cfg.serviceSlug}` : `/embed/${slug}`;
  const q = new URLSearchParams();
  q.set("color", cfg.color);
  if (cfg.radius !== 12) q.set("radius", String(cfg.radius));
  if (cfg.compact) q.set("compact", "1");
  if (cfg.hideHeader) q.set("hideHeader", "1");
  if (cfg.utmSource) q.set("utm_source", cfg.utmSource);
  if (cfg.utmMedium) q.set("utm_medium", cfg.utmMedium);
  if (cfg.utmCampaign) q.set("utm_campaign", cfg.utmCampaign);
  return `${baseUrl}${path}?${q.toString()}`;
}

function buildDirectLink(baseUrl: string, slug: string, cfg: EmbedConfig): string {
  const path = cfg.serviceSlug ? `/u/${slug}/${cfg.serviceSlug}` : `/u/${slug}`;
  const q = new URLSearchParams();
  if (cfg.utmSource) q.set("utm_source", cfg.utmSource);
  if (cfg.utmMedium) q.set("utm_medium", cfg.utmMedium);
  if (cfg.utmCampaign) q.set("utm_campaign", cfg.utmCampaign);
  const qs = q.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
}

function dataAttrs(slug: string, cfg: EmbedConfig): string {
  const attrs: [string, string | number][] = [
    ["data-zentromeet-tenant", slug],
    ["data-zentromeet-service", cfg.serviceSlug],
    ["data-zentromeet-color", cfg.color],
    ["data-zentromeet-radius", String(cfg.radius)],
  ];
  if (cfg.compact) attrs.push(["data-zentromeet-compact", "true"]);
  if (cfg.hideHeader) attrs.push(["data-zentromeet-hide-header", "true"]);
  if (cfg.utmSource) attrs.push(["data-zentromeet-utm-source", cfg.utmSource]);
  if (cfg.utmMedium) attrs.push(["data-zentromeet-utm-medium", cfg.utmMedium]);
  if (cfg.utmCampaign) attrs.push(["data-zentromeet-utm-campaign", cfg.utmCampaign]);
  if (cfg.mode === "popup" || cfg.mode === "floating") {
    attrs.push(["data-zentromeet-label", cfg.buttonLabel]);
    if (cfg.mode === "floating") {
      attrs.push(["data-zentromeet-position", cfg.position]);
      if (cfg.autoOpen) {
        attrs.push(["data-zentromeet-auto-open", "true"]);
        attrs.push(["data-zentromeet-auto-open-delay", String(cfg.autoOpenDelayMs)]);
      }
    }
  }
  return attrs.map(([k, v]) => `  ${k}="${v}"`).join("\n");
}

function buildSnippet(framework: Framework, baseUrl: string, slug: string, cfg: EmbedConfig, canHideBranding: boolean): string {
  const scriptUrl = `${baseUrl}/embed/v1.js`;
  const attrs = dataAttrs(slug, cfg);
  void canHideBranding;

  if (framework === "html") {
    if (cfg.mode === "inline") {
      return `<!-- Inline ZentroMeet booking embed -->
<div
  data-zentromeet-inline
${attrs}
></div>
<script async defer src="${scriptUrl}"></script>`;
    }
    if (cfg.mode === "popup") {
      return `<!-- Popup trigger -->
<button
  data-zentromeet-popup
${attrs}
  style="background:${cfg.color};color:#fff;border:0;padding:11px 18px;border-radius:10px;font:600 14px/1 system-ui;cursor:pointer"
>
  ${escapeHtml(cfg.buttonLabel)}
</button>
<script async defer src="${scriptUrl}"></script>`;
    }
    if (cfg.mode === "floating") {
      return `<!-- Floating launcher button -->
<script
  async defer
  src="${scriptUrl}"
  data-zentromeet-floating
${attrs}
></script>`;
    }
    if (cfg.mode === "fullpage") {
      return `<!-- Direct link · white-label booking microsite -->
<a
  href="${buildDirectLink(baseUrl, slug, cfg)}"
  target="_blank"
  rel="noopener noreferrer"
  style="background:${cfg.color};color:#fff;text-decoration:none;display:inline-block;padding:11px 18px;border-radius:10px;font:600 14px/1 system-ui"
>
  ${escapeHtml(cfg.buttonLabel)}
</a>`;
    }
  }

  if (framework === "react") {
    if (cfg.mode === "inline") {
      return `import { useEffect } from "react";

// Load the embed runtime once, app-wide.
function useZentroMeet() {
  useEffect(() => {
    if (document.getElementById("zm-embed-v1")) return;
    const s = document.createElement("script");
    s.id = "zm-embed-v1";
    s.async = true;
    s.defer = true;
    s.src = "${scriptUrl}";
    document.head.appendChild(s);
  }, []);
}

export default function BookingEmbed() {
  useZentroMeet();
  return (
    <div
      data-zentromeet-inline
      data-zentromeet-tenant="${slug}"
      data-zentromeet-service="${cfg.serviceSlug}"
      data-zentromeet-color="${cfg.color}"
      data-zentromeet-radius="${cfg.radius}"
      style={{ maxWidth: 560, minHeight: ${cfg.minHeight} }}
    />
  );
}`;
    }
    return `import { useEffect } from "react";

function useZentroMeet() {
  useEffect(() => {
    if (document.getElementById("zm-embed-v1")) return;
    const s = document.createElement("script");
    s.id = "zm-embed-v1";
    s.async = true;
    s.defer = true;
    s.src = "${scriptUrl}";
    document.head.appendChild(s);
  }, []);
}

export default function BookButton() {
  useZentroMeet();
  return (
    <button
      data-zentromeet-popup
      data-zentromeet-tenant="${slug}"
      data-zentromeet-service="${cfg.serviceSlug}"
      data-zentromeet-color="${cfg.color}"
      data-zentromeet-label="${escapeHtml(cfg.buttonLabel)}"
      style={{ background: "${cfg.color}", color: "#fff", border: 0, padding: "11px 18px", borderRadius: 10, font: "600 14px/1 system-ui" }}
    >
      ${escapeHtml(cfg.buttonLabel)}
    </button>
  );
}`;
  }

  if (framework === "nextjs") {
    return `// app/components/BookingEmbed.tsx
"use client";

import Script from "next/script";

export default function BookingEmbed() {
  return (
    <>
      <Script src="${scriptUrl}" strategy="afterInteractive" />
      <div
        data-zentromeet-${cfg.mode === "popup" ? "popup" : "inline"}
        data-zentromeet-tenant="${slug}"
        data-zentromeet-service="${cfg.serviceSlug}"
        data-zentromeet-color="${cfg.color}"
        data-zentromeet-radius="${cfg.radius}"
        style={{ maxWidth: 560 }}
      />
    </>
  );
}`;
  }

  if (framework === "wordpress") {
    return `<!-- Paste into a Custom HTML block, or in your theme's footer.php
     before </body>. WordPress strips most <script> tags from the editor
     unless you use the official Custom HTML block. -->
${cfg.mode === "inline" ? `<div
  data-zentromeet-inline
${attrs}
></div>` : `<button
  data-zentromeet-popup
${attrs}
  style="background:${cfg.color};color:#fff;border:0;padding:11px 18px;border-radius:10px;font:600 14px/1 system-ui;cursor:pointer"
>
  ${escapeHtml(cfg.buttonLabel)}
</button>`}
<script async defer src="${scriptUrl}"></script>`;
  }

  if (framework === "webflow") {
    return `<!-- Webflow: Project Settings → Custom Code → Footer Code -->
<script async defer src="${scriptUrl}"></script>

<!-- Then add an Embed element on the page where you want the widget -->
${cfg.mode === "inline" ? `<div
  data-zentromeet-inline
${attrs}
></div>` : `<button
  data-zentromeet-popup
${attrs}
  style="background:${cfg.color};color:#fff;border:0;padding:11px 18px;border-radius:10px;font:600 14px/1 system-ui;cursor:pointer"
>
  ${escapeHtml(cfg.buttonLabel)}
</button>`}`;
  }

  return "";
}

// ─── Preview iframe with shimmer loading ─────────────────────────

function PreviewIframe({
  src,
  title,
  height,
  radius,
}: {
  src: string;
  title: string;
  height: number;
  radius: number;
}) {
  const [loaded, setLoaded] = React.useState(false);
  // Reset loaded state whenever src changes
  React.useEffect(() => {
    setLoaded(false);
  }, [src]);
  return (
    <div className="relative" style={{ height: `${height}px` }}>
      {/* Shimmer skeleton — only visible until the iframe fires onLoad.
          Keeps the layout from shifting when params change. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 transition-opacity duration-[280ms]",
          loaded ? "opacity-0" : "opacity-100",
        )}
        style={{ borderRadius: `${radius}px` }}
      >
        <div className="h-full w-full bg-gradient-to-b from-slate-50 to-white" style={{ borderRadius: `${radius}px` }}>
          <div className="zm-embed-shimmer h-full w-full" style={{ borderRadius: `${radius}px` }} />
        </div>
        <style jsx>{`
          .zm-embed-shimmer {
            background: linear-gradient(
              90deg,
              rgba(241, 245, 249, 0) 0%,
              rgba(241, 245, 249, 0.55) 50%,
              rgba(241, 245, 249, 0) 100%
            );
            background-size: 200% 100%;
            animation: zmShimmer 1400ms cubic-bezier(0.16, 1, 0.3, 1) infinite;
          }
          @keyframes zmShimmer {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
          }
        `}</style>
      </div>
      <iframe
        key={src}
        src={src}
        title={title}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className={cn(
          "block h-full w-full bg-white transition-opacity duration-[280ms]",
          loaded ? "opacity-100" : "opacity-0",
        )}
        style={{ borderRadius: `${radius}px` }}
      />
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────

function EmbedEmptyState() {
  return (
    <PremiumCard className="relative overflow-hidden p-6 sm:p-10">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-16 h-44 w-44 rounded-full bg-brand-accent/12 blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute -left-12 -bottom-12 h-32 w-32 rounded-full bg-emerald-200/[0.16] blur-3xl" />
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />

      <div className="relative grid items-center gap-6 sm:grid-cols-[minmax(0,1fr),minmax(0,1fr)]">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-brand-accent">
            <Sparkles className="h-3 w-3" strokeWidth={2.25} />
            One service away
          </div>
          <h3 className="mt-2 text-[18px] font-semibold tracking-tight text-ink sm:text-[20px]">
            Create a service to start embedding
          </h3>
          <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
            Embeds book real services on your booking flow. Once you publish at least one service with an assigned host, the studio unlocks live preview, install snippets for 5 frameworks, QR codes, and UTM tracking.
          </p>
          <a
            href="/dashboard/settings/services"
            className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-b from-brand-accent to-brand-hover px-3.5 text-[12px] font-semibold text-white shadow-[0_2px_8px_-2px_rgba(37,99,235,0.30),inset_0_1px_0_rgba(255,255,255,0.18)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:shadow-[0_6px_18px_-4px_rgba(37,99,235,0.42)]"
          >
            Create your first service
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
          </a>

          <ul className="mt-4 space-y-1.5">
            {[
              "Inline · Popup · Floating · Full-page modes",
              "HTML, React, Next.js, WordPress, Webflow snippets",
              "Branded QR codes + UTM tracking + edge cache",
            ].map((line) => (
              <li key={line} className="flex items-start gap-1.5 text-[11.5px] text-ink-muted">
                <Check className="mt-[3px] h-2.5 w-2.5 shrink-0 text-emerald-600" strokeWidth={2.5} />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Visual: stylized booking-card mock */}
        <div
          aria-hidden
          className="relative mx-auto w-full max-w-[320px] overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-b from-slate-50 to-white p-3.5 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.30),inset_0_1px_0_rgba(255,255,255,0.65)]"
        >
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-brand-accent/85" />
            <div>
              <div className="h-2 w-24 rounded-full bg-slate-200" />
              <div className="mt-1 h-1.5 w-16 rounded-full bg-slate-100" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1">
            {Array.from({ length: 9 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "h-7 rounded-md",
                  i === 4 ? "bg-brand-accent/85" : "bg-slate-100",
                )}
              />
            ))}
          </div>
          <div className="mt-3 h-9 rounded-lg bg-brand-accent/85 shadow-sm" />
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Trust strip ─────────────────────────────────────────────────

export function EmbedTrustStrip() {
  const items: { icon: LucideIcon; label: string; sub: string }[] = [
    { icon: ShieldCheck, label: "HTTPS only", sub: "TLS everywhere" },
    { icon: Sparkles, label: "Mobile optimized", sub: "Touch-first flow" },
    { icon: Zap, label: "Edge delivered", sub: "24h CDN cache" },
    { icon: Globe, label: "Works anywhere", sub: "Any framework" },
    { icon: Code2, label: "Async loader", sub: "Lazy iframe mount" },
    { icon: PanelTop, label: "16 KB runtime", sub: "Zero deps · no eval" },
  ];
  return (
    <div className="rounded-2xl border border-border/55 bg-surface/75 p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-sm sm:p-3">
      <ul className="grid grid-cols-2 gap-x-2 gap-y-2 sm:grid-cols-3 sm:gap-x-1 lg:grid-cols-6">
        {items.map((t) => {
          const Icon = t.icon;
          return (
            <li
              key={t.label}
              className="group/trust flex items-start gap-2 rounded-lg p-1.5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-surface-inset/40"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-subtle to-surface text-brand-accent ring-1 ring-brand-accent/20 shadow-[0_1px_3px_-1px_rgba(37,99,235,0.22),inset_0_1px_0_rgba(255,255,255,0.55)] transition-all duration-[220ms] group-hover/trust:scale-[1.03] group-hover/trust:shadow-[0_2px_8px_-1px_rgba(37,99,235,0.30),inset_0_1px_0_rgba(255,255,255,0.55)]">
                <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
              </span>
              <div className="min-w-0">
                <div className="text-[11.5px] font-semibold leading-[1.2] tracking-tight text-ink">{t.label}</div>
                <div className="mt-0.5 text-[10.5px] leading-[1.25] text-ink-muted">{t.sub}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
}
