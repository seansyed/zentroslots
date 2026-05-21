"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Mail,
  Palette,
  Sparkles,
  XCircle,
} from "lucide-react";

import { Button, Card, toast } from "@/components/ui/primitives";

// ─── Public contract ──────────────────────────────────────────────────
//
// The page builds `sections` server-side so a section can never list a
// feature key that doesn't live in `FEATURE_FLAGS`. Read-only refs use
// a separate type so the toggle UI can't accidentally render a switch
// for an externally-managed policy.

export type FeatureSectionDef = {
  id: "booking" | "automation" | "calendar" | "branding";
  title: string;
  summary: string;
  /** Subset of FEATURE_FLAGS rendered as live toggles in this section. */
  keys: string[];
};

export type SystemHealthSnapshot = {
  smtpReady: boolean;
  googleCalendarConnections: number;
  googleProviderEnabled: boolean;
  customDomainsCount: number;
  webhookConfigured: boolean;
  hidePoweredBy: boolean;
};

export type ExternalPolicyRef = {
  sectionId: FeatureSectionDef["id"];
  label: string;
  detail: string;
  /**
   * active     — capability is live, no admin action required
   * available  — capability exists on plan/setup but not engaged
   * disabled   — capability is configured off (or missing prerequisite)
   * plan_gated — capability requires plan upgrade
   */
  status: "active" | "available" | "disabled" | "plan_gated";
  manageHref: string;
  manageLabel: string;
};

type FlagMeta = { label: string; description: string; impact: string };

type PlanInfo = {
  id: string;
  name: string;
  customBranding: boolean;
  maxCustomDomains: number;
};

export default function FeatureControlsClient({
  initialFlags,
  defaults,
  meta,
  keys,
  sections,
  externalRefs,
  systemHealth,
  plan,
}: {
  initialFlags: Record<string, boolean>;
  defaults: Record<string, boolean>;
  meta: Record<string, FlagMeta>;
  keys: string[];
  sections: FeatureSectionDef[];
  externalRefs: ExternalPolicyRef[];
  systemHealth: SystemHealthSnapshot;
  plan: PlanInfo;
}) {
  const [flags, setFlags] = React.useState<Record<string, boolean>>(initialFlags);
  const [busy, setBusy] = React.useState(false);

  const dirty = React.useMemo(
    () => keys.some((k) => flags[k] !== initialFlags[k]),
    [flags, initialFlags, keys],
  );
  const changedCount = React.useMemo(
    () => keys.reduce((n, k) => (flags[k] !== initialFlags[k] ? n + 1 : n), 0),
    [flags, initialFlags, keys],
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
      toast("Feature controls updated", "success");
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

  // Total live counts for the hero
  const totalLiveFlags = keys.length;
  const flagsOn = keys.reduce((n, k) => (flags[k] ? n + 1 : n), 0);
  const externalActive = externalRefs.filter((r) => r.status === "active").length;

  const refsBySection = React.useMemo(() => {
    const out: Record<string, ExternalPolicyRef[]> = {};
    for (const r of externalRefs) {
      (out[r.sectionId] ??= []).push(r);
    }
    return out;
  }, [externalRefs]);

  return (
    <div className="mt-6 space-y-6 pb-24">
      {/* ── Hero / command-center header ────────────────────────── */}
      <Card className="overflow-hidden p-0">
        <div className="bg-gradient-to-br from-brand-accent/8 via-surface to-surface px-6 py-7">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-brand-accent">
                  <Sparkles className="h-3 w-3" /> Workspace policy
                </span>
                <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-ink-muted">
                  {plan.name} plan
                </span>
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink">
                Feature controls
              </h1>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
                Every switch on this page enforces real runtime behavior — APIs honor it,
                the engine reads it, and the audit log records who changed it. Externally
                managed capabilities are shown as read-only references with links to their
                dedicated pages.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <HeroStat
                value={`${flagsOn}/${totalLiveFlags}`}
                label="Live toggles on"
              />
              <HeroStat
                value={String(externalActive)}
                label="External policies active"
              />
              <HeroStat
                value={changedCount > 0 ? `${changedCount}` : "—"}
                label="Unsaved changes"
                accent={changedCount > 0 ? "amber" : "muted"}
              />
            </div>
          </div>
        </div>
      </Card>

      {/* ── Sections ────────────────────────────────────────────── */}
      {sections.map((section) => {
        const sectionFlags = section.keys.filter((k) => meta[k]);
        const sectionRefs = refsBySection[section.id] ?? [];
        const Icon = sectionIcon(section.id);
        return (
          <section key={section.id} className="space-y-3">
            <header className="flex items-start gap-3 px-1">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-accent/10 text-brand-accent">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-ink">{section.title}</h2>
                <p className="mt-0.5 text-sm text-ink-muted">{section.summary}</p>
              </div>
            </header>

            {sectionFlags.length > 0 && (
              <div className="space-y-3">
                {sectionFlags.map((k) => {
                  const m = meta[k]!;
                  const on = flags[k] ?? defaults[k] ?? true;
                  const changed = initialFlags[k] !== on;
                  const healthLine = healthHintFor(k, systemHealth);
                  return (
                    <Card key={k} className="p-5">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-ink">{m.label}</h3>
                            <StatusPill
                              tone={on ? "on" : "off"}
                              label={on ? "Enabled" : "Disabled"}
                            />
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
                          {healthLine && (
                            <p className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-surface-muted/60 px-2 py-1 text-[11px] text-ink-muted">
                              <span
                                className={
                                  "h-1.5 w-1.5 rounded-full " +
                                  (healthLine.tone === "ok"
                                    ? "bg-emerald-500"
                                    : healthLine.tone === "warn"
                                      ? "bg-amber-500"
                                      : "bg-slate-400")
                                }
                              />
                              {healthLine.text}
                            </p>
                          )}
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
              </div>
            )}

            {sectionRefs.length > 0 && (
              <div className="space-y-2">
                {sectionRefs.map((r) => (
                  <ExternalRefRow key={`${r.sectionId}:${r.label}`} ref_={r} />
                ))}
              </div>
            )}

            {sectionFlags.length === 0 && sectionRefs.length === 0 && (
              <Card className="p-5 text-sm text-ink-muted">
                No policies wired for this section yet.
              </Card>
            )}
          </section>
        );
      })}

      {/* ── Save bar ────────────────────────────────────────────── */}
      <div className="sticky bottom-4 z-10 flex items-center justify-between gap-2 rounded-2xl border border-border bg-surface/95 px-4 py-3 shadow-md backdrop-blur">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          {dirty ? (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              {changedCount} unsaved {changedCount === 1 ? "change" : "changes"}
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              All changes saved
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
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
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────

function HeroStat({
  value,
  label,
  accent = "default",
}: {
  value: string;
  label: string;
  accent?: "default" | "amber" | "muted";
}) {
  return (
    <div className="min-w-[88px] rounded-xl border border-border bg-surface px-3 py-2 text-left">
      <div
        className={
          "text-lg font-semibold tabular-nums " +
          (accent === "amber"
            ? "text-amber-700"
            : accent === "muted"
              ? "text-ink-subtle"
              : "text-ink")
        }
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-ink-muted">{label}</div>
    </div>
  );
}

function StatusPill({
  tone,
  label,
}: {
  tone: "on" | "off";
  label: string;
}) {
  if (tone === "on") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      {label}
    </span>
  );
}

function ExternalRefRow({ ref_ }: { ref_: ExternalPolicyRef }) {
  const meta = externalRefVisual(ref_.status);
  return (
    <Card className="flex items-start gap-3 p-4">
      <div
        className={
          "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg " + meta.iconWrap
        }
      >
        <meta.Icon className={"h-4 w-4 " + meta.iconColor} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink">{ref_.label}</span>
          <span
            className={
              "rounded-full px-2 py-0.5 text-[10px] font-medium " + meta.pill
            }
          >
            {meta.statusLabel}
          </span>
          <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-medium text-ink-subtle">
            Managed elsewhere
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-muted">{ref_.detail}</p>
      </div>
      <Link
        href={ref_.manageHref}
        className="ml-2 inline-flex shrink-0 items-center gap-1 self-center rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-surface-muted"
      >
        {ref_.manageLabel}
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </Card>
  );
}

function externalRefVisual(status: ExternalPolicyRef["status"]) {
  switch (status) {
    case "active":
      return {
        Icon: CheckCircle2,
        iconWrap: "bg-emerald-50",
        iconColor: "text-emerald-600",
        pill: "bg-emerald-50 text-emerald-700",
        statusLabel: "Active",
      };
    case "available":
      return {
        Icon: CircleAlert,
        iconWrap: "bg-amber-50",
        iconColor: "text-amber-600",
        pill: "bg-amber-50 text-amber-700",
        statusLabel: "Available",
      };
    case "disabled":
      return {
        Icon: XCircle,
        iconWrap: "bg-slate-100",
        iconColor: "text-slate-500",
        pill: "bg-slate-100 text-slate-600",
        statusLabel: "Not configured",
      };
    case "plan_gated":
      return {
        Icon: Sparkles,
        iconWrap: "bg-violet-50",
        iconColor: "text-violet-600",
        pill: "bg-violet-50 text-violet-700",
        statusLabel: "Plan upgrade required",
      };
  }
}

function sectionIcon(id: FeatureSectionDef["id"]) {
  switch (id) {
    case "booking":
      return CheckCircle2;
    case "automation":
      return Mail;
    case "calendar":
      return CalendarClock;
    case "branding":
      return Palette;
  }
}

// Per-toggle health hint. Renders nothing for flags that don't have a
// natural live signal. Honesty rule: every line MUST reflect actual
// backend state — never a hard-coded "All systems normal" string.
function healthHintFor(
  key: string,
  h: SystemHealthSnapshot,
): { tone: "ok" | "warn" | "muted"; text: string } | null {
  switch (key) {
    case "emailNotifications":
      return h.smtpReady
        ? { tone: "ok", text: "SMTP provider is configured and ready." }
        : { tone: "warn", text: "SMTP is NOT configured — sends will fail even when this toggle is on." };
    case "reminders":
      return h.smtpReady
        ? { tone: "ok", text: "Reminder cron will dispatch via the configured SMTP provider." }
        : { tone: "warn", text: "SMTP is not configured — reminders cannot deliver." };
    case "webhookDelivery":
      return h.webhookConfigured
        ? { tone: "ok", text: "Notification webhook URL is set on this workspace." }
        : { tone: "muted", text: "No webhook URL configured — toggle has no effect until one is set." };
    case "googleMeet":
      if (!h.googleProviderEnabled) {
        return { tone: "warn", text: "Google Calendar is disabled at the workspace level — Meet links cannot be generated." };
      }
      return h.googleCalendarConnections > 0
        ? { tone: "ok", text: `${h.googleCalendarConnections} staff Google connection${h.googleCalendarConnections === 1 ? "" : "s"} available for Meet link creation.` }
        : { tone: "muted", text: "No staff have connected a Google account — Meet links require a connected calendar." };
    case "bookingBuffers":
      return { tone: "muted", text: "Per-service buffer minutes live on each service. This toggle is the kill switch." };
    case "intakeForms":
      return { tone: "muted", text: "Intake forms attach to individual services. This toggle is the kill switch." };
    case "rescheduling":
    case "cancellations":
      return { tone: "muted", text: "Affects both customer self-service routes and dashboard actions." };
    default:
      return null;
  }
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
