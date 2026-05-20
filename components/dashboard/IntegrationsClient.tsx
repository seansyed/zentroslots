"use client";

import * as React from "react";
import Link from "next/link";
import {
  Calendar,
  Video,
  MessageCircle,
  Users,
  Workflow,
  Layers,
  GitBranch,
  Sparkles,
  ArrowUpRight,
  Info,
} from "lucide-react";

import { Badge, Button, toast } from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

// ─── Workspace Integrations ────────────────────────────────────────
//
// Provider enablement at the TENANT level. This page never touches
// OAuth tokens — those are per-staff and live in calendarConnections.
// REFINEMENT #4: strong helper messaging makes the architecture
// ownership clear so operators don't expect this page to manage
// personal calendars.
//
// Source of truth for the provider matrix: GET /api/tenant/integrations/providers
// Disable/enable per provider: PUT /api/tenant/integrations/providers
//
// REFINEMENT #7: disabling a provider here does NOT touch existing
// per-staff connections. The booking engine continues to honor their
// busy events. Only NEW connect attempts are blocked.

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

const CATEGORY_META: Record<Provider["category"], { label: string; icon: typeof Calendar }> = {
  calendar: { label: "Calendars",     icon: Calendar },
  video:    { label: "Video meetings", icon: Video },
  chat:     { label: "Chat & alerts",  icon: MessageCircle },
};

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
      toast("This provider is not yet wired — coming soon.", "info");
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
      toast(next ? `${p.name} enabled for workspace` : `${p.name} disabled for workspace`, "success");
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
    const out: Record<Provider["category"], Provider[]> = { calendar: [], video: [], chat: [] };
    for (const p of providers ?? []) out[p.category].push(p);
    return out;
  }, [providers]);

  return (
    <div className="mt-5 space-y-5">
      {/* Architecture ownership helper — REFINEMENT #4 */}
      <PremiumCard className="relative overflow-hidden p-4">
        <span aria-hidden className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/12 blur-3xl" />
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent" />
        <div className="relative flex items-start gap-3">
          <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15">
            <Info className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Workspace integrations
            </div>
            <h2 className="mt-0.5 text-[14.5px] font-semibold tracking-tight text-ink">
              Enable providers globally
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
              Workspace integrations enable providers globally. <strong className="font-semibold text-ink">Each staff
              member connects their own calendar from their workforce profile.</strong> Disabling a provider here
              blocks new connections but never affects existing busy-event sync for connected staff.
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

      {/* Provider matrix grouped by category */}
      {(["calendar", "video", "chat"] as const).map((cat) => {
        const meta = CATEGORY_META[cat];
        const Icon = meta.icon;
        const list = grouped[cat];
        if (list.length === 0) return null;
        return (
          <PremiumCard key={cat} className="p-4">
            <div className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-brand-accent" strokeWidth={1.75} />
              <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">{meta.label}</h3>
            </div>
            <div className="mt-3 space-y-2">
              {list.map((p) => (
                <ProviderRow
                  key={p.id}
                  provider={p}
                  busy={togglingId === p.id}
                  onToggle={() => toggleProvider(p)}
                />
              ))}
            </div>
          </PremiumCard>
        );
      })}

      {/* Slack webhook + branding (existing workspace settings) */}
      <PremiumCard className="p-4">
        <div className="flex items-center gap-2">
          <MessageCircle className="h-4 w-4 text-brand-accent" strokeWidth={1.75} />
          <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">Outbound webhook</h3>
        </div>
        <p className="mt-1 text-[11.5px] text-ink-muted">
          POST a JSON payload to any URL on booking events. Slack&rsquo;s incoming-webhook URLs work out of the box.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="url"
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder="https://hooks.slack.com/services/…"
            className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-[12.5px]"
          />
          <Button size="sm" onClick={saveWebhook} disabled={savingWebhook}>
            {savingWebhook ? "…" : "Save"}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-ink-subtle">
          Payload: <code className="rounded bg-surface-inset px-1 py-0.5 font-mono">{`{ text, event, bookingId, … }`}</code>
        </p>
      </PremiumCard>

      <PremiumCard className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">Hide &ldquo;Powered by ZentroMeet&rdquo;</h3>
              {!plan.canHideBadge && <Badge tone="amber">Pro plan</Badge>}
            </div>
            <p className="mt-1 text-[11.5px] text-ink-muted">
              On Pro and Team, remove the platform footer from your public booking page and embed widget.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={hideBadge}
            onClick={toggleBadge}
            disabled={savingBadge}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
              hideBadge ? "bg-brand-accent" : "bg-surface-inset",
            )}
          >
            <span
              className={cn(
                "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                hideBadge ? "translate-x-5" : "translate-x-0",
              )}
            />
          </button>
        </div>
      </PremiumCard>

      {/* Future routing scaffolds — REFINEMENT #9 */}
      <PremiumCard className="p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          v2 routing intelligence
        </div>
        <h3 className="mt-0.5 text-[14px] font-semibold tracking-tight text-ink">Coming soon</h3>
        <p className="mt-0.5 text-[11.5px] text-ink-muted">
          Once staff calendars own availability, the routing engine can layer richer assignment logic without
          rewriting the core. These features ship on top of the existing per-staff foundation.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ScaffoldTile icon={Workflow} title="Round-robin scheduling" caption="Distribute bookings evenly across pooled staff." />
          <ScaffoldTile icon={Users} title="Pooled availability" caption="Any-available scheduling across a service&rsquo;s eligible staff." />
          <ScaffoldTile icon={Layers} title="Collective scheduling" caption="Bookings requiring multiple staff present simultaneously." />
          <ScaffoldTile icon={GitBranch} title="Department routing" caption="Department-aware availability + assignment fallbacks." />
          <ScaffoldTile icon={Sparkles} title="Workload balancing" caption="Smart distribution that respects each staff&rsquo;s utilization." />
          <ScaffoldTile icon={Users} title="Alternate host suggestions" caption="Offer alternate staff when the preferred host is full." />
        </div>
      </PremiumCard>
    </div>
  );
}

// ─── Provider row ─────────────────────────────────────────────────

function ProviderRow({
  provider,
  busy,
  onToggle,
}: {
  provider: Provider;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border bg-surface px-3.5 py-3 transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        provider.enabled
          ? "border-border hover:border-border-strong"
          : "border-border/60 bg-surface-inset/30",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold tracking-tight text-ink">{provider.name}</span>
          {!provider.wired && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
              Coming soon
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{provider.description}</p>
      </div>
      <ProviderToggle on={provider.enabled} disabled={busy || !provider.wired} onChange={onToggle} />
    </div>
  );
}

function ProviderToggle({
  on,
  onChange,
  disabled,
}: {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      disabled={disabled}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40",
        on ? "bg-brand-accent" : "bg-surface-inset ring-1 ring-border",
        disabled && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.20)] transition-transform duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          on ? "translate-x-[18px]" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function ScaffoldTile({
  icon: Icon,
  title,
  caption,
}: {
  icon: typeof Workflow;
  title: string;
  caption: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-dashed border-border bg-surface-inset/30 p-3">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start gap-2.5">
        <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface text-ink-subtle ring-1 ring-border/40">
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="text-[12px] font-semibold tracking-tight text-ink">{title}</h4>
            <span className="inline-flex items-center gap-1 rounded-full bg-surface px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-[0.06em] text-ink-subtle ring-1 ring-border/40">
              Soon
            </span>
          </div>
          <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-muted">{caption}</p>
        </div>
      </div>
    </div>
  );
}
