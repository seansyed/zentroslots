"use client";

/**
 * Integrations Command Center (Phase 20).
 *
 * Behavior is byte-identical to the previous implementation — same
 * `/api/tenant/integrations/providers` (GET/PUT) calls, same
 * `/api/tenant/integrations` PATCH for webhook + hidePoweredBy. All
 * persisted state shapes preserved. This file is a UI transformation
 * only: provider rows → premium provider cards with brand identity,
 * operational chips, capability matrix, security trust strip, and a
 * command-center hero.
 *
 * Architectural ownership preserved:
 *   - Workspace integrations enable providers GLOBALLY.
 *   - Per-staff OAuth tokens live in calendarConnections and are
 *     managed elsewhere — this page never touches them.
 *   - Disabling a provider here blocks NEW connect attempts; the
 *     booking engine still honors existing busy-event sync.
 */

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  Calendar,
  Check,
  ChevronDown,
  Copy,
  GitBranch,
  Info,
  KeyRound,
  Layers,
  Lock,
  MessageCircle,
  Plug,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Users,
  Video,
  Webhook as WebhookIcon,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { Button, toast } from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

// ─── Types ────────────────────────────────────────────────────────

type Provider = {
  id: string;
  name: string;
  description: string;
  wired: boolean;
  category: "calendar" | "video" | "chat";
  enabled: boolean;
};

type Init = {
  notificationWebhookUrl: string;
  hidePoweredBy: boolean;
};

type Category = Provider["category"];

const CATEGORY_META: Record<
  Category,
  { label: string; icon: LucideIcon; eyebrow: string; description: string }
> = {
  calendar: {
    label: "Calendar infrastructure",
    icon: Calendar,
    eyebrow: "Source of truth",
    description:
      "Per-staff OAuth · busy-event sync · auto-create meeting links.",
  },
  video: {
    label: "Meeting infrastructure",
    icon: Video,
    eyebrow: "Conferencing",
    description:
      "Confirmed bookings auto-generate a meeting link per the host's connected provider.",
  },
  chat: {
    label: "Operational alerts",
    icon: MessageCircle,
    eyebrow: "Notifications",
    description: "Outbound JSON to Slack, Discord, or any HTTPS endpoint.",
  },
};

// ─── Provider visual identity (brand-keyed) ───────────────────────
//
// Single-letter monograms in brand-colored discs — recognizable but
// trademark-safe. Capabilities are honest statements about what the
// integration enables today (or will enable). Roadmap copy uses the
// premium phrasing called for in PART 8 of the brief.

type ProviderVisual = {
  brandColor: string;
  monogram: string;
  /** Premium roadmap label for non-wired providers. */
  roadmap?: string;
  capabilities: string[];
  /** Optional inline link target — e.g. Slack → webhook section. */
  linkLabel?: string;
  linkHref?: string;
};

const PROVIDER_VISUAL: Record<string, ProviderVisual> = {
  google_calendar: {
    brandColor: "#4285F4",
    monogram: "G",
    capabilities: [
      "Two-way busy-event sync",
      "Auto-generate Google Meet links",
      "Per-staff OAuth — independent per user",
      "Real-time conflict detection",
    ],
    linkLabel: "Connect a staff calendar",
    linkHref: "/dashboard/staff",
  },
  outlook: {
    brandColor: "#0078D4",
    monogram: "O",
    roadmap: "Backend in progress",
    capabilities: [
      "Exchange / Microsoft 365 calendar sync",
      "Free-busy aware availability windows",
      "Per-staff Microsoft OAuth",
    ],
  },
  zoom: {
    brandColor: "#2D8CFF",
    monogram: "Z",
    roadmap: "Enterprise preview",
    capabilities: [
      "Auto-generate Zoom links on confirmation",
      "Per-host Zoom account routing",
      "Recording metadata pass-through (planned)",
    ],
  },
  teams: {
    brandColor: "#5059C9",
    monogram: "T",
    roadmap: "Enterprise preview",
    capabilities: [
      "Auto-generate Teams meeting links",
      "Organization tenant directory integration",
      "Per-host Microsoft 365 routing",
    ],
  },
  slack: {
    brandColor: "#611f69",
    monogram: "S",
    roadmap: "Webhook ready",
    capabilities: [
      "Outbound JSON alerts via incoming webhook",
      "Compatible with Slack, Discord, and custom HTTPS endpoints",
      "Native OAuth Slack app — rolling out",
    ],
    linkLabel: "Configure webhook below",
    linkHref: "#webhook-section",
  },
};

// ─── Component ────────────────────────────────────────────────────

export default function IntegrationsClient({
  initial,
  plan,
}: {
  initial: Init;
  plan: { id: string; name: string; canHideBadge: boolean };
}) {
  const [providers, setProviders] = React.useState<Provider[] | null>(null);
  const [webhook, setWebhook] = React.useState(initial.notificationWebhookUrl);
  const [hideBadge, setHideBadge] = React.useState(initial.hidePoweredBy);
  const [savingWebhook, setSavingWebhook] = React.useState(false);
  const [savingBadge, setSavingBadge] = React.useState(false);
  const [togglingId, setTogglingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch("/api/tenant/integrations/providers")
      .then((r) => r.json())
      .then((d) => setProviders(d?.providers ?? []))
      .catch(() => setProviders([]));
  }, []);

  async function toggleProvider(p: Provider) {
    if (!p.wired) {
      toast(`${p.name} is on the roadmap — coming soon.`, "info");
      return;
    }
    const next = !p.enabled;
    setTogglingId(p.id);
    try {
      const r = await fetch("/api/tenant/integrations/providers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: p.id, enabled: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      setProviders(d?.providers ?? null);
      toast(
        next ? `${p.name} enabled for workspace` : `${p.name} disabled for workspace`,
        "success",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setTogglingId(null);
    }
  }

  async function saveWebhook() {
    setSavingWebhook(true);
    try {
      const r = await fetch("/api/tenant/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationWebhookUrl: webhook || null }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      toast("Webhook saved", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingWebhook(false);
    }
  }

  async function toggleBadge() {
    if (!plan.canHideBadge) {
      toast("Upgrade to Pro to hide the Powered-by badge.", "info");
      return;
    }
    const next = !hideBadge;
    setHideBadge(next);
    setSavingBadge(true);
    try {
      const r = await fetch("/api/tenant/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidePoweredBy: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? "Failed");
      toast(next ? "Badge hidden" : "Badge restored", "success");
    } catch (e) {
      setHideBadge(!next);
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingBadge(false);
    }
  }

  // Group by category for the matrix render.
  const grouped = React.useMemo(() => {
    const out: Record<Category, Provider[]> = { calendar: [], video: [], chat: [] };
    for (const p of providers ?? []) out[p.category].push(p);
    return out;
  }, [providers]);

  // Hero KPIs — derived honestly from the catalog state.
  const summary = React.useMemo(() => {
    const list = providers ?? [];
    const total = list.length;
    const connected = list.filter((p) => p.wired && p.enabled).length;
    const available = list.filter((p) => p.wired && !p.enabled).length;
    const upcoming = list.filter((p) => !p.wired).length;
    const calendarReady = list.some(
      (p) => p.id === "google_calendar" && p.wired && p.enabled,
    );
    return { total, connected, available, upcoming, calendarReady };
  }, [providers]);

  const loading = providers === null;

  return (
    <div className="mt-3 space-y-4">
      {/* ───────── COMMAND CENTER HERO ───────────────────────────────── */}
      <CommandCenterHero summary={summary} loading={loading} />

      {/* ───────── ARCHITECTURE HELPER ───────────────────────────────── */}
      <ArchitectureHelper />

      {/* ───────── SECURITY / TRUST STRIP ────────────────────────────── */}
      <SecurityTrustStrip />

      {/* ───────── PROVIDER CATEGORIES ───────────────────────────────── */}
      {(["calendar", "video", "chat"] as const).map((cat) => {
        const meta = CATEGORY_META[cat];
        const list = grouped[cat];
        if (loading || list.length === 0) {
          if (!loading) return null;
          // Skeleton while providers fetch
          return <CategorySkeleton key={cat} />;
        }
        return (
          <CategorySection
            key={cat}
            cat={cat}
            meta={meta}
            providers={list}
            togglingId={togglingId}
            onToggle={toggleProvider}
          />
        );
      })}

      {/* ───────── WEBHOOK / AUTOMATION ──────────────────────────────── */}
      <WebhookSection
        webhook={webhook}
        setWebhook={setWebhook}
        savingWebhook={savingWebhook}
        onSave={saveWebhook}
      />

      {/* ───────── BRANDING TOGGLE ───────────────────────────────────── */}
      <BrandingToggleCard
        hideBadge={hideBadge}
        savingBadge={savingBadge}
        onToggle={toggleBadge}
        canHide={plan.canHideBadge}
      />

      {/* ───────── ROUTING INTELLIGENCE PREVIEW ──────────────────────── */}
      <RoutingIntelligencePreview />
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────

function CommandCenterHero({
  summary,
  loading,
}: {
  summary: {
    total: number;
    connected: number;
    available: number;
    upcoming: number;
    calendarReady: boolean;
  };
  loading: boolean;
}) {
  const syncTone = summary.calendarReady
    ? {
        label: "Calendar sync operational",
        dot: "bg-emerald-500",
        ring: "shadow-[0_0_0_4px_rgba(16,185,129,0.18)]",
        chip: "bg-emerald-50 text-emerald-700 ring-emerald-200/40",
      }
    : {
        label: "Awaiting first calendar",
        dot: "bg-amber-500",
        ring: "shadow-[0_0_0_4px_rgba(245,158,11,0.18)]",
        chip: "bg-amber-50 text-amber-700 ring-amber-200/40",
      };
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/15 blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -left-20 -bottom-20 h-56 w-56 rounded-full bg-emerald-200/[0.18] blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
      />

      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            <Plug className="h-3 w-3" strokeWidth={2} />
            Command center
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Integrations Command Center
          </h1>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-ink-muted">
            Connect calendars, meeting providers, notifications, and workflow systems across
            your workspace. Each connection is OAuth-scoped per staff member, fully isolated,
            and audit-ready.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] ring-1",
                syncTone.chip,
              )}
            >
              <span
                aria-hidden
                className={cn("inline-block h-1.5 w-1.5 rounded-full", syncTone.dot, syncTone.ring)}
              />
              {syncTone.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm">
              <Activity className="h-2.5 w-2.5" strokeWidth={2} />
              Real-time provider state
            </span>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex flex-wrap items-center gap-1.5">
          <HeroAction
            href="/dashboard/staff"
            icon={Users}
            label="Manage staff connections"
            primary
          />
          <HeroAction href="#webhook-section" icon={WebhookIcon} label="Webhook" />
          <HeroAction
            href="#routing-intel"
            icon={GitBranch}
            label="Roadmap"
          />
        </div>
      </div>

      {/* KPI strip */}
      <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <HeroKpi
          icon={Check}
          label="Connected"
          value={loading ? "—" : summary.connected.toString()}
          sub={loading ? "Loading…" : `of ${summary.total} providers`}
          tone="positive"
        />
        <HeroKpi
          icon={Plug}
          label="Available"
          value={loading ? "—" : summary.available.toString()}
          sub="Ready to enable"
          tone="brand"
        />
        <HeroKpi
          icon={Sparkles}
          label="On roadmap"
          value={loading ? "—" : summary.upcoming.toString()}
          sub="Early access"
          tone="amber"
        />
        <HeroKpi
          icon={ShieldCheck}
          label="Posture"
          value="OAuth 2.0"
          sub="Per-staff isolation"
          tone="neutral"
        />
      </div>
    </PremiumCard>
  );
}

function HeroAction({
  href,
  icon: Icon,
  label,
  primary,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  primary?: boolean;
}) {
  const className = primary
    ? "inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-accent px-3 text-[11.5px] font-semibold text-white shadow-[0_2px_8px_-2px_rgba(53,157,243,0.30)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:shadow-[0_6px_18px_-4px_rgba(53,157,243,0.42)]"
    : "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[11.5px] font-medium text-ink-muted shadow-sm transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:bg-surface-inset hover:text-ink hover:shadow-md";
  return (
    <Link href={href} className={className}>
      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      {label}
      {primary && <ArrowUpRight className="h-3 w-3" strokeWidth={2.25} />}
    </Link>
  );
}

function HeroKpi({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  tone: "brand" | "positive" | "amber" | "neutral";
}) {
  const toneCls =
    tone === "positive"
      ? "from-emerald-50 to-emerald-100/30 text-emerald-700 ring-emerald-200/40"
      : tone === "amber"
        ? "from-amber-50 to-amber-100/30 text-amber-700 ring-amber-200/40"
        : tone === "brand"
          ? "from-brand-subtle to-surface text-brand-accent ring-brand-accent/15"
          : "from-surface-inset to-surface text-ink-subtle ring-border/40";
  return (
    <div className="rounded-xl border border-border/60 bg-surface/80 p-2.5 ring-1 ring-inset ring-white/40 backdrop-blur-sm">
      <div className="flex items-center gap-1.5">
        <span
          className={cn(
            "inline-flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br ring-1",
            toneCls,
          )}
        >
          <Icon className="h-3 w-3" strokeWidth={2} />
        </span>
        <span className="text-[9.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
          {label}
        </span>
      </div>
      <div className="mt-1.5 text-[18px] font-semibold leading-none tabular-nums tracking-tight text-ink">
        {value}
      </div>
      <div className="mt-1 text-[10px] text-ink-muted">{sub}</div>
    </div>
  );
}

// ─── Architecture helper ──────────────────────────────────────────

function ArchitectureHelper() {
  return (
    <PremiumCard className="relative overflow-hidden p-3.5">
      <span
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/12 blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      <div className="relative flex items-start gap-3">
        <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
          <Info className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            How this works
          </div>
          <h2 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">
            Workspace enables providers · staff connect their own accounts
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
            Toggling a provider here makes it available across your workspace.
            <strong className="font-semibold text-ink">
              {" "}
              Each staff member then connects their own calendar from their workforce profile.
            </strong>{" "}
            Disabling a provider blocks new connections but never affects existing busy-event
            sync for already-connected staff.
          </p>
          <div className="mt-2">
            <Link
              href="/dashboard/staff"
              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-accent hover:underline"
            >
              Manage staff calendar connections
              <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
            </Link>
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Security trust strip ─────────────────────────────────────────

const TRUST_ITEMS: { icon: LucideIcon; label: string; sub: string }[] = [
  { icon: KeyRound, label: "OAuth 2.0", sub: "Industry-standard auth" },
  { icon: Lock, label: "Encrypted at rest", sub: "Token storage isolated" },
  { icon: Users, label: "Per-staff scope", sub: "No shared credentials" },
  { icon: ShieldCheck, label: "Audit-ready", sub: "Every action logged" },
];

function SecurityTrustStrip() {
  return (
    <div className="rounded-2xl border border-border/55 bg-surface/75 p-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.6)] backdrop-blur-sm transition-colors duration-300 hover:border-border/80 sm:p-3">
      <ul className="grid grid-cols-2 gap-x-2 gap-y-2 sm:grid-cols-4 sm:gap-x-1">
        {TRUST_ITEMS.map((t) => {
          const Icon = t.icon;
          return (
            <li
              key={t.label}
              className="group/trust flex items-start gap-2 rounded-lg p-1.5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-surface-inset/40"
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-subtle to-surface text-brand-accent ring-1 ring-brand-accent/15 shadow-[0_1px_3px_-1px_rgba(53,157,243,0.18)] transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/trust:shadow-[0_2px_8px_-1px_rgba(53,157,243,0.26)] group-hover/trust:ring-brand-accent/30">
                <Icon className="h-3.5 w-3.5" strokeWidth={2} />
              </span>
              <div className="min-w-0">
                <div className="text-[11.5px] font-semibold leading-[1.2] tracking-tight text-ink">
                  {t.label}
                </div>
                <div className="mt-0.5 text-[10.5px] leading-[1.25] text-ink-muted">
                  {t.sub}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── Category section ─────────────────────────────────────────────

function CategorySection({
  cat,
  meta,
  providers,
  togglingId,
  onToggle,
}: {
  cat: Category;
  meta: (typeof CATEGORY_META)[Category];
  providers: Provider[];
  togglingId: string | null;
  onToggle: (p: Provider) => void;
}) {
  const Icon = meta.icon;
  // Anchor IDs used by hero quick-actions
  const anchorId = cat === "calendar" ? "calendar-section" : undefined;
  return (
    <section id={anchorId} className="relative scroll-mt-6">
      <header className="mb-1.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-subtle text-brand-accent ring-1 ring-brand-accent/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
              <Icon className="h-3.5 w-3.5" strokeWidth={2} />
            </span>
            <div className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-brand-accent">
              {meta.eyebrow}
            </div>
          </div>
          <h2 className="mt-1.5 text-[15.5px] font-semibold leading-[1.2] tracking-tight text-ink">
            {meta.label}
          </h2>
          <p className="mt-0.5 text-[11.5px] leading-[1.45] text-ink-muted">{meta.description}</p>
        </div>
        {/* Quiet count chip for scannability across categories */}
        <span className="hidden shrink-0 items-center gap-1 self-start rounded-full bg-surface-inset px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.10em] text-ink-subtle ring-1 ring-border/50 sm:inline-flex">
          {providers.length} provider{providers.length === 1 ? "" : "s"}
        </span>
      </header>

      <div className="space-y-2">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            busy={togglingId === p.id}
            onToggle={() => onToggle(p)}
          />
        ))}
      </div>
    </section>
  );
}

function CategorySkeleton() {
  return (
    <div className="rounded-2xl border border-border/60 bg-surface p-4 shadow-soft">
      <div className="h-3 w-24 animate-pulse rounded bg-surface-inset" />
      <div className="mt-2 h-4 w-48 animate-pulse rounded bg-surface-inset" />
      <div className="mt-3 space-y-2">
        <div className="h-16 animate-pulse rounded-xl bg-surface-inset/60" />
        <div className="h-16 animate-pulse rounded-xl bg-surface-inset/60" />
      </div>
    </div>
  );
}

// ─── Provider card ────────────────────────────────────────────────

function ProviderCard({
  provider,
  busy,
  onToggle,
}: {
  provider: Provider;
  busy: boolean;
  onToggle: () => void;
}) {
  const v = PROVIDER_VISUAL[provider.id];
  const state = providerState(provider);
  const isLive = provider.enabled && provider.wired;
  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-surface p-3.5 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] sm:p-4",
        isLive
          ? // Live providers: stronger border + two-layer shadow stack + dual inner highlight (top + bottom) → "active infrastructure surface"
            "border-border-strong shadow-[0_1px_2px_rgba(15,23,42,0.06),0_2px_6px_-3px_rgba(15,23,42,0.06),inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-1px_0_rgba(15,23,42,0.025)] hover:-translate-y-px hover:shadow-[0_12px_30px_-14px_rgba(15,23,42,0.20),0_4px_10px_-4px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.65)]"
          : provider.wired
            ? "border-border/70 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_1px_0_rgba(255,255,255,0.45)] hover:-translate-y-px hover:border-border hover:shadow-[0_8px_20px_-12px_rgba(15,23,42,0.16),inset_0_1px_0_rgba(255,255,255,0.45)]"
            : // Roadmap providers: solid (not muted) — readiness, not "missing"
              "border-border/70 shadow-[0_1px_2px_rgba(15,23,42,0.03),inset_0_1px_0_rgba(255,255,255,0.40)] hover:border-border hover:shadow-[0_8px_20px_-12px_rgba(15,23,42,0.14),inset_0_1px_0_rgba(255,255,255,0.40)]",
      )}
    >
      {/* Brand rail — fades in on hover only when live, otherwise quiet */}
      {isLive && v && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-3.5 left-0 w-[2px] rounded-r-full opacity-0 transition-opacity duration-300 group-hover:opacity-100"
          style={{ backgroundColor: v.brandColor }}
        />
      )}

      {/* Article-level row: mark · content · toggle (toggle self-centers vertically) */}
      <div className="flex items-center gap-3">
        <ProviderMark
          letter={v?.monogram ?? provider.name[0]}
          color={v?.brandColor ?? "#64748b"}
          active={isLive}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="text-[13.5px] font-semibold tracking-tight text-ink">
              {provider.name}
            </h4>
            <ConnectionStateChip state={state} roadmap={v?.roadmap} />
          </div>
          <p className="mt-0.5 text-[11.5px] leading-[1.45] text-ink-muted">
            {provider.description}
          </p>

          {/* Capabilities — telemetry-density (Part 7) */}
          {v?.capabilities && v.capabilities.length > 0 && (
            <ul className="mt-2 grid gap-y-[3px] gap-x-3 sm:grid-cols-2">
              {v.capabilities.map((cap) => (
                <li
                  key={cap}
                  className="flex items-start gap-1.5 text-[10.5px] leading-[1.3] text-ink-muted"
                >
                  <span
                    className={cn(
                      "mt-[3.5px] inline-flex h-2 w-2 shrink-0 items-center justify-center rounded-full",
                      isLive
                        ? "bg-emerald-500/90 text-white shadow-[0_0_0_2px_rgba(16,185,129,0.15)]"
                        : provider.wired
                          ? "bg-slate-300 text-white"
                          : "bg-slate-300 text-white",
                    )}
                  >
                    {isLive ? (
                      <Check className="h-1.5 w-1.5" strokeWidth={4} />
                    ) : null}
                  </span>
                  <span>{cap}</span>
                </li>
              ))}
            </ul>
          )}

          {/* Inline contextual link */}
          {v?.linkLabel && v?.linkHref && (
            <div className="mt-1.5">
              <Link
                href={v.linkHref}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-accent transition-colors hover:text-brand-hover"
              >
                {v.linkLabel}
                <ArrowUpRight className="h-3 w-3" strokeWidth={2.25} />
              </Link>
            </div>
          )}
        </div>

        {/* Toggle column — perfectly vertical-centered by items-center on the parent flex */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ProviderToggle
            on={provider.enabled}
            disabled={busy || !provider.wired}
            onChange={onToggle}
            brandColor={v?.brandColor}
          />
        </div>
      </div>
    </article>
  );
}

// ─── Connection state taxonomy ───────────────────────────────────

type ConnectionState =
  | "connected"
  | "available"
  | "roadmap"
  | "disabled";

function providerState(p: Provider): ConnectionState {
  if (p.wired && p.enabled) return "connected";
  if (p.wired && !p.enabled) return "disabled";
  return "roadmap";
}

function ConnectionStateChip({
  state,
  roadmap,
}: {
  state: ConnectionState;
  roadmap?: string;
}) {
  // All chips share the SAME pill structure (size, padding, weight,
  // tracking, ring thickness) — only color family + content vary.
  // This makes the section read as one unified badge language.
  const base =
    "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] ring-1";

  if (state === "connected") {
    // Gold-standard Live badge — production-connected confidence (Part 3 + 4)
    return (
      <span
        className={cn(
          base,
          "bg-gradient-to-b from-emerald-50 to-emerald-100/60 text-emerald-800 ring-emerald-300/60 shadow-[0_1px_2px_-1px_rgba(16,185,129,0.22)]",
        )}
      >
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.24)]"
        />
        Live
      </span>
    );
  }

  if (state === "disabled") {
    return (
      <span
        className={cn(
          base,
          "bg-surface-inset text-ink-muted ring-border/40",
        )}
      >
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400" />
        Available
      </span>
    );
  }

  // Roadmap — color family varies per status but pill structure is identical (Part 5)
  const tone = roadmapTone(roadmap);
  return (
    <span className={cn(base, tone.classes)}>
      <Sparkles className="h-2 w-2" strokeWidth={2.5} />
      {roadmap ?? "Early access"}
    </span>
  );
}

function roadmapTone(roadmap: string | undefined): { classes: string } {
  const r = (roadmap ?? "").toLowerCase();
  // Each roadmap status carries its own color family for instant
  // scanning, while the pill shape stays unified.
  if (r.includes("webhook")) {
    return {
      classes:
        "bg-gradient-to-b from-emerald-50 to-emerald-100/45 text-emerald-700 ring-emerald-200/55",
    };
  }
  if (r.includes("enterprise")) {
    return {
      classes:
        "bg-gradient-to-b from-violet-50 to-violet-100/45 text-violet-700 ring-violet-200/55",
    };
  }
  if (r.includes("rolling")) {
    return {
      classes:
        "bg-gradient-to-b from-amber-50 to-amber-100/45 text-amber-700 ring-amber-200/55",
    };
  }
  if (r.includes("infrastructure")) {
    return {
      classes:
        "bg-gradient-to-b from-indigo-50 to-indigo-100/45 text-indigo-700 ring-indigo-200/55",
    };
  }
  // Default: "Backend in progress", "Early access" — blue (active development)
  return {
    classes:
      "bg-gradient-to-b from-blue-50 to-blue-100/45 text-blue-700 ring-blue-200/55",
  };
}

// ─── Provider mark (monogram disc) ───────────────────────────────

function ProviderMark({
  letter,
  color,
  active,
}: {
  letter: string;
  color: string;
  active: boolean;
}) {
  const initial = (letter || "?").toUpperCase().slice(0, 1);
  return (
    <div className="relative shrink-0">
      {/* Soft brand bloom — only behind LIVE marks. Quiet on roadmap. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 rounded-xl blur-md transition-opacity duration-300",
          active ? "opacity-30" : "opacity-0 group-hover:opacity-12",
        )}
        style={{ backgroundColor: color }}
      />
      <div
        className="relative flex h-10 w-10 items-center justify-center rounded-xl text-[14.5px] font-semibold leading-none tracking-tight text-white shadow-[0_2px_8px_-2px_rgba(15,23,42,0.20),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(0,0,0,0.10)] ring-1 ring-black/[0.08] transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.04]"
        style={{
          background: `linear-gradient(135deg, ${color} 0%, ${darken(color, 0.20)} 100%)`,
          // Full color for every provider — roadmap providers are still
          // recognizable, the roadmap chip is the only state indicator.
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-1 top-0.5 h-2 rounded-md bg-gradient-to-b from-white/14 to-transparent"
        />
        <span className="relative">{initial}</span>
      </div>
    </div>
  );
}

// ─── Provider toggle ──────────────────────────────────────────────

function ProviderToggle({
  on,
  onChange,
  disabled,
  brandColor,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
  brandColor?: string;
}) {
  const c = brandColor ?? "#359df3";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      disabled={disabled}
      className={cn(
        "group/toggle relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        on
          ? // Live: dual inset depth + soft brand-tinted glow → operational feel
            "shadow-[inset_0_1px_2px_rgba(15,23,42,0.14),inset_0_-1px_0_rgba(255,255,255,0.12),0_0_0_3px_var(--toggle-glow,rgba(53,157,243,0.14))]"
          : // Off: better track contrast + hover lift
            "bg-surface-inset ring-1 ring-border/70 hover:ring-border hover:bg-surface-inset/80",
        // Disabled state: staged-but-unavailable — slightly more visible than 0.5
        disabled && "cursor-not-allowed opacity-[0.55] saturate-[0.85] hover:ring-border/70",
      )}
      style={
        on
          ? ({
              backgroundColor: c,
              ["--tw-ring-color" as never]: c,
              ["--toggle-glow" as never]: hexAlpha(c, 0.18),
            } as React.CSSProperties)
          : undefined
      }
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          on
            ? // Thumb glow when ON — subtle outer halo + crisp inner highlight
              "translate-x-[18px] shadow-[0_1px_3px_rgba(15,23,42,0.28),0_0_0_1px_rgba(255,255,255,0.55),inset_0_0.5px_0_rgba(255,255,255,0.75)]"
            : "translate-x-0.5 shadow-[0_1px_3px_rgba(15,23,42,0.20),inset_0_0.5px_0_rgba(255,255,255,0.55)] group-hover/toggle:shadow-[0_2px_5px_rgba(15,23,42,0.24)]",
        )}
      />
    </button>
  );
}

// Lightweight hex → rgba helper (no deps).
function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(53,157,243,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 0xff}, ${(n >> 8) & 0xff}, ${n & 0xff}, ${alpha})`;
}

// ─── Webhook section ──────────────────────────────────────────────

const WEBHOOK_EVENTS = [
  "booking.created",
  "booking.confirmed",
  "booking.cancelled",
  "booking.rescheduled",
  "booking.completed",
  "booking.no_show",
];

const SAMPLE_PAYLOAD = `{
  "text": "New booking confirmed",
  "event": "booking.created",
  "bookingId": "bkg_…",
  "service": "30-min consult",
  "host": "alex@your-co.com",
  "startsAt": "2026-05-21T16:00:00Z"
}`;

function WebhookSection({
  webhook,
  setWebhook,
  savingWebhook,
  onSave,
}: {
  webhook: string;
  setWebhook: (s: string) => void;
  savingWebhook: boolean;
  onSave: () => void;
}) {
  const [showPayload, setShowPayload] = React.useState(false);
  const copyPayload = async () => {
    try {
      await navigator.clipboard.writeText(SAMPLE_PAYLOAD);
      toast("Sample payload copied", "success");
    } catch {
      toast("Copy failed — select manually", "error");
    }
  };
  return (
    <PremiumCard
      id="webhook-section"
      className="relative scroll-mt-6 overflow-hidden p-4 sm:p-5"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-subtle text-brand-accent ring-1 ring-brand-accent/15">
              <WebhookIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>
            <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Automation infrastructure
            </span>
          </div>
          <h3 className="mt-1.5 text-[14.5px] font-semibold tracking-tight text-ink">
            Outbound webhook
          </h3>
          <p className="mt-0.5 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
            POST a JSON payload to any HTTPS endpoint on booking events. Slack&rsquo;s
            incoming-webhook URLs, Discord webhooks, n8n, Zapier, and custom services all
            work without further configuration.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-emerald-700 ring-1 ring-emerald-200/50">
          <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]" />
          Endpoint ready
        </span>
      </header>

      <div className="mt-3.5">
        <label className="block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
          Endpoint URL
        </label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <span
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
            >
              <WebhookIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
            </span>
            <input
              type="url"
              value={webhook}
              onChange={(e) => setWebhook(e.target.value)}
              placeholder="https://hooks.slack.com/services/…"
              className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 font-mono text-[12px] text-ink outline-none transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] placeholder:font-sans placeholder:text-ink-subtle focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15"
            />
          </div>
          <Button size="sm" onClick={onSave} disabled={savingWebhook}>
            {savingWebhook ? "Saving…" : "Save endpoint"}
          </Button>
        </div>
      </div>

      {/* Subscribed events + payload — premium developer console feel */}
      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr),minmax(0,1.2fr)]">
        <div className="rounded-xl border border-border/65 bg-surface-subtle/60 p-3">
          <div className="flex items-center gap-1.5">
            <Zap className="h-3 w-3 text-amber-600" strokeWidth={2} />
            <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Subscribed events
            </span>
          </div>
          <ul className="mt-2 space-y-1">
            {WEBHOOK_EVENTS.map((ev) => (
              <li
                key={ev}
                className="flex items-center gap-1.5 font-mono text-[10.5px] text-ink-muted"
              >
                <span
                  aria-hidden
                  className="inline-block h-1 w-1 rounded-full bg-brand-accent"
                />
                {ev}
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-border/65 bg-[#0b1220] p-0.5 shadow-[0_4px_14px_-6px_rgba(15,23,42,0.30)]">
          <div className="flex items-center justify-between gap-2 px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              <TerminalSquare className="h-3 w-3 text-slate-400" strokeWidth={2} />
              <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-slate-400">
                Sample payload
              </span>
            </div>
            <button
              type="button"
              onClick={copyPayload}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-slate-300 transition-colors hover:bg-white/[0.06] hover:text-white"
            >
              <Copy className="h-2.5 w-2.5" strokeWidth={2.25} />
              Copy
            </button>
          </div>
          <pre className="overflow-x-auto rounded-[10px] bg-[#0b1220] px-3 py-2 font-mono text-[10.5px] leading-[1.55] text-slate-200">
            <code>{SAMPLE_PAYLOAD}</code>
          </pre>
        </div>
      </div>

      {/* Forward-looking: delivery history future-ready layout */}
      <button
        type="button"
        onClick={() => setShowPayload((x) => !x)}
        className="mt-3.5 flex w-full items-center justify-between gap-2 rounded-lg border border-dashed border-border bg-surface-inset/30 px-3 py-2 text-[11.5px] text-ink-muted transition-colors hover:bg-surface-inset/60"
      >
        <span className="inline-flex items-center gap-1.5">
          <Activity className="h-3 w-3" strokeWidth={2} />
          Delivery history & signing secrets
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-200/50">
            <Sparkles className="h-2 w-2" strokeWidth={2.25} />
            Infrastructure ready
          </span>
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform duration-200",
              showPayload ? "rotate-180" : "",
            )}
            strokeWidth={2}
          />
        </span>
      </button>
      {showPayload && (
        <div className="mt-2 rounded-lg border border-border/65 bg-surface-subtle/50 p-3 text-[11px] leading-relaxed text-ink-muted">
          <p>
            Per-delivery retry, exponential backoff, and HMAC-signed payloads are wired in the
            backend. The dashboard surface for inspecting delivery logs, re-sending failed
            events, and rotating signing secrets will roll out in the next release.
          </p>
          <ul className="mt-2 space-y-0.5">
            <li className="flex items-start gap-1.5">
              <Check className="mt-[3px] h-2.5 w-2.5 shrink-0 text-emerald-600" strokeWidth={3} />
              <span>HMAC-SHA256 signature header (rolling out)</span>
            </li>
            <li className="flex items-start gap-1.5">
              <Check className="mt-[3px] h-2.5 w-2.5 shrink-0 text-emerald-600" strokeWidth={3} />
              <span>Per-event delivery log (rolling out)</span>
            </li>
            <li className="flex items-start gap-1.5">
              <Check className="mt-[3px] h-2.5 w-2.5 shrink-0 text-emerald-600" strokeWidth={3} />
              <span>One-click replay for failed deliveries (rolling out)</span>
            </li>
          </ul>
        </div>
      )}
    </PremiumCard>
  );
}

// ─── Branding toggle ──────────────────────────────────────────────

function BrandingToggleCard({
  hideBadge,
  savingBadge,
  onToggle,
  canHide,
}: {
  hideBadge: boolean;
  savingBadge: boolean;
  onToggle: () => void;
  canHide: boolean;
}) {
  return (
    <PremiumCard className="relative overflow-hidden p-4">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-brand-accent" strokeWidth={2} />
            <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
              White-label · hide &ldquo;Powered by ZentroMeet&rdquo;
            </h3>
            {!canHide && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-200/50">
                <Lock className="h-2 w-2" strokeWidth={2.25} />
                Pro plan
              </span>
            )}
          </div>
          <p className="mt-1 max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
            On Pro and Team, remove the platform footer from your public booking page and
            embed widget. Calendar invites and emails continue to be sent from your domain.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={hideBadge}
          onClick={onToggle}
          disabled={savingBadge}
          className={cn(
            "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
            hideBadge ? "bg-brand-accent shadow-[inset_0_1px_2px_rgba(15,23,42,0.10)]" : "bg-surface-inset ring-1 ring-border/60",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.20)] transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              hideBadge ? "translate-x-5" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </PremiumCard>
  );
}

// ─── Routing intelligence preview (v2) ───────────────────────────

function RoutingIntelligencePreview() {
  return (
    <PremiumCard
      id="routing-intel"
      className="relative scroll-mt-6 overflow-hidden bg-gradient-to-br from-brand-subtle/40 via-surface to-surface p-4 sm:p-5"
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-brand-accent/15 blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      <header className="relative">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-brand-accent text-white shadow-sm">
            <Sparkles className="h-3 w-3" strokeWidth={2.25} />
          </span>
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
            Workforce orchestration · v2 preview
          </div>
        </div>
        <h3 className="mt-1.5 text-[15px] font-semibold tracking-tight text-ink">
          AI-powered routing intelligence
        </h3>
        <p className="mt-0.5 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
          With per-staff calendars now owning availability, the routing engine can layer
          richer assignment logic without rewriting the core. These capabilities ship on top
          of the foundation you already have.
        </p>
      </header>

      <div className="relative mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ScaffoldTile
          icon={Workflow}
          title="Round-robin scheduling"
          caption="Distribute bookings evenly across pooled staff."
          status="Backend in progress"
        />
        <ScaffoldTile
          icon={Users}
          title="Pooled availability"
          caption="Any-available scheduling across a service's eligible staff."
          status="Backend in progress"
        />
        <ScaffoldTile
          icon={Layers}
          title="Collective scheduling"
          caption="Bookings requiring multiple staff present simultaneously."
          status="Early access"
        />
        <ScaffoldTile
          icon={GitBranch}
          title="Department routing"
          caption="Department-aware availability + assignment fallbacks."
          status="Infrastructure ready"
        />
        <ScaffoldTile
          icon={Sparkles}
          title="Workload balancing"
          caption="Smart distribution that respects each staff's utilization."
          status="Enterprise preview"
        />
        <ScaffoldTile
          icon={Users}
          title="Alternate host suggestions"
          caption="Offer alternate staff when the preferred host is full."
          status="Rolling out"
        />
      </div>
    </PremiumCard>
  );
}

function ScaffoldTile({
  icon: Icon,
  title,
  caption,
  status,
}: {
  icon: LucideIcon;
  title: string;
  caption: string;
  status: string;
}) {
  return (
    <div className="group/tile relative overflow-hidden rounded-xl border border-border/70 bg-surface/85 p-3 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-px hover:border-border-strong hover:shadow-[0_6px_14px_-8px_rgba(15,23,42,0.16)]">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent"
      />
      <div className="flex items-start gap-2.5">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-subtle to-surface text-brand-accent ring-1 ring-brand-accent/15 shadow-sm transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/tile:scale-[1.03]">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="text-[12px] font-semibold tracking-tight text-ink">{title}</h4>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.06em] text-amber-700 ring-1 ring-amber-200/50">
              <Sparkles className="h-2 w-2" strokeWidth={2.25} />
              {status}
            </span>
          </div>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">{caption}</p>
        </div>
      </div>
    </div>
  );
}

// ─── Color helper (hex-only) ─────────────────────────────────────

function darken(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.round(((n >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.round(((n >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.round((n & 0xff) * (1 - amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
