"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  CircleAlert,
  Clock,
  ExternalLink,
  Globe,
  History,
  Info,
  Lock,
  Mail,
  MailWarning,
  Palette,
  RotateCcw,
  Server,
  Shield,
  ShieldCheck,
  Sparkles,
  Video,
  Webhook,
  XCircle,
  Zap,
} from "lucide-react";

import { Button, Card, Modal, toast } from "@/components/ui/primitives";

// ─── Public contract ──────────────────────────────────────────────────

export type FeatureSectionDef = {
  id: "booking" | "automation" | "scheduling" | "branding";
  title: string;
  summary: string;
  /** Subset of FEATURE_FLAGS rendered as live toggles in this section. */
  keys: string[];
};

export type SystemHealthSnapshot = {
  smtpReady: boolean;
  googleCalendarConnections: number;
  googleCalendarErrors: number;
  googleProviderEnabled: boolean;
  customDomainsCount: number;
  webhookConfigured: boolean;
  hidePoweredBy: boolean;
  workspaceActive: boolean;
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
   * always_on  — core safety/platform guarantee, not toggleable
   */
  status: "active" | "available" | "disabled" | "plan_gated" | "always_on";
  planLocked: boolean;
  /** Minimum plan tier that unlocks this capability. Used to render
   *  the "Available on Pro" / "Team plan required" badge on locked
   *  cards. Optional — refs without a required tier (SMTP delivery,
   *  webhook URL, always-on safeguards) omit it. */
  requiredPlan?: "free" | "solo" | "pro" | "team" | "enterprise";
  manageHref: string;
  manageLabel: string;
};

export type FlagAuditEntry = {
  actorName: string | null;
  actorEmail: string | null;
  /** ISO timestamp of the most recent change. */
  at: string;
  /** Audit source identifier — useful for debugging "where did this come from". */
  source: string;
};

export type OperationalHealthItem = {
  id: string;
  label: string;
  status: "ok" | "degraded" | "down" | "muted";
  detail: string;
};

export type DependencyWarning = {
  flag: string;
  tone: "warning" | "info";
  message: string;
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
  operationalHealth,
  dependencyWarnings,
  flagAudit,
  plan,
}: {
  initialFlags: Record<string, boolean>;
  defaults: Record<string, boolean>;
  meta: Record<string, FlagMeta>;
  keys: string[];
  sections: FeatureSectionDef[];
  externalRefs: ExternalPolicyRef[];
  systemHealth: SystemHealthSnapshot;
  operationalHealth: OperationalHealthItem[];
  dependencyWarnings: DependencyWarning[];
  flagAudit: Record<string, FlagAuditEntry>;
  plan: PlanInfo;
}) {
  const [flags, setFlags] = React.useState<Record<string, boolean>>(initialFlags);
  const [busy, setBusy] = React.useState(false);
  const [resetModalOpen, setResetModalOpen] = React.useState(false);

  const dirty = React.useMemo(
    () => keys.some((k) => flags[k] !== initialFlags[k]),
    [flags, initialFlags, keys],
  );
  const changedCount = React.useMemo(
    () => keys.reduce((n, k) => (flags[k] !== initialFlags[k] ? n + 1 : n), 0),
    [flags, initialFlags, keys],
  );
  const changedKeys = React.useMemo(
    () => keys.filter((k) => flags[k] !== initialFlags[k]),
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
      if (data?.flags) setFlags(data.flags);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  }

  function applyReset() {
    setFlags({ ...defaults });
    setResetModalOpen(false);
  }

  // Total live counts for the hero
  const totalLiveFlags = keys.length;
  const flagsOn = keys.reduce((n, k) => (flags[k] ? n + 1 : n), 0);
  const externalActive = externalRefs.filter(
    (r) => r.status === "active" || r.status === "always_on",
  ).length;
  const lockedCount = externalRefs.filter((r) => r.planLocked).length;

  const refsBySection = React.useMemo(() => {
    const out: Record<string, ExternalPolicyRef[]> = {};
    for (const r of externalRefs) {
      (out[r.sectionId] ??= []).push(r);
    }
    return out;
  }, [externalRefs]);

  const warningsByFlag = React.useMemo(() => {
    const out: Record<string, DependencyWarning[]> = {};
    for (const w of dependencyWarnings) {
      (out[w.flag] ??= []).push(w);
    }
    return out;
  }, [dependencyWarnings]);

  return (
    <div className="mt-6 space-y-6 pb-28">
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
            <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
              <HeroStat value={`${flagsOn}/${totalLiveFlags}`} label="Live toggles on" />
              <HeroStat
                value={String(externalActive)}
                label="External policies active"
              />
              <HeroStat
                value={String(lockedCount)}
                label="Locked capabilities"
                accent={lockedCount > 0 ? "violet" : "muted"}
              />
              <HeroStat
                value={changedCount > 0 ? `${changedCount}` : "—"}
                label="Unsaved changes"
                accent={changedCount > 0 ? "amber" : "muted"}
              />
            </div>
          </div>
        </div>

        {/* ── Live operational health strip ──────────────────────── */}
        <div className="border-t border-border bg-surface-muted/40 px-6 py-3">
          <div className="flex flex-wrap items-center gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1.5 font-semibold uppercase tracking-wide text-ink-subtle">
              <Activity className="h-3 w-3" /> System
            </span>
            {operationalHealth.map((item) => (
              <OperationalChip key={item.id} item={item} />
            ))}
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
                  const audit = flagAudit[k];
                  const warnings = warningsByFlag[k] ?? [];
                  return (
                    <PolicyCard
                      key={k}
                      flagKey={k}
                      meta={m}
                      checked={on}
                      changed={changed}
                      busy={busy}
                      onChange={(v) => setFlag(k, v)}
                      audit={audit}
                      warnings={warnings}
                      healthHint={healthHintFor(k, systemHealth)}
                    />
                  );
                })}
              </div>
            )}

            {sectionRefs.length > 0 && (
              <div className="space-y-2">
                {sectionFlags.length > 0 && (
                  <div className="flex items-center gap-2 px-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">
                    <span className="h-px flex-1 bg-border" />
                    Managed elsewhere
                    <span className="h-px flex-1 bg-border" />
                  </div>
                )}
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

      {/* ── Save bar — desktop + mobile ─────────────────────────── */}
      <div className="sticky bottom-4 z-10 flex items-center justify-between gap-2 rounded-2xl border border-border bg-surface/95 px-4 py-3 shadow-md backdrop-blur sm:bottom-6">
        <div className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
          {dirty ? (
            <>
              <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              <span className="truncate">
                {changedCount} unsaved {changedCount === 1 ? "change" : "changes"}
              </span>
            </>
          ) : (
            <>
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="truncate">All changes saved</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setResetModalOpen(true)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-muted hover:bg-surface-muted hover:text-ink disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
          <Button onClick={save} disabled={!dirty || busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      {/* ── Reset confirmation modal ────────────────────────────── */}
      <Modal
        open={resetModalOpen}
        onClose={() => setResetModalOpen(false)}
        title="Restore plan defaults?"
      >
        <p className="text-sm text-ink-muted">
          This will reset every workspace toggle on this page to its default value
          — preserving the pre-flag behavior every tenant starts with. The change is
          staged locally; nothing is written until you click <strong>Save changes</strong>.
        </p>
        <div className="mt-4 max-h-56 overflow-auto rounded-lg border border-border bg-surface-muted/40 p-3">
          <div className="space-y-1.5 text-xs">
            {keys.map((k) => {
              const m = meta[k];
              if (!m) return null;
              const current = flags[k] ?? defaults[k];
              const target = defaults[k];
              const willChange = current !== target;
              return (
                <div
                  key={k}
                  className={
                    "flex items-center justify-between gap-2 " +
                    (willChange ? "text-ink" : "text-ink-subtle")
                  }
                >
                  <span className="truncate font-medium">{m.label}</span>
                  <span className="shrink-0 tabular-nums">
                    {willChange ? (
                      <>
                        <span className={current ? "text-emerald-600" : "text-slate-500"}>
                          {current ? "on" : "off"}
                        </span>
                        <span className="mx-1 text-ink-subtle">→</span>
                        <span className={target ? "text-emerald-600" : "text-slate-500"}>
                          {target ? "on" : "off"}
                        </span>
                      </>
                    ) : (
                      <span className="text-ink-subtle">no change</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <p className="mt-3 text-[11px] text-ink-subtle">
          Read-only references (custom domains, branding, integrations, public booking
          page) are <em>not</em> affected — they live on their own settings pages.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setResetModalOpen(false)}
            className="rounded-md px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink"
          >
            Cancel
          </button>
          <Button onClick={applyReset}>Stage defaults</Button>
        </div>
      </Modal>
    </div>
  );
}

// ─── Policy card ──────────────────────────────────────────────────────

function PolicyCard({
  flagKey,
  meta,
  checked,
  changed,
  busy,
  onChange,
  audit,
  warnings,
  healthHint,
}: {
  flagKey: string;
  meta: FlagMeta;
  checked: boolean;
  changed: boolean;
  busy: boolean;
  onChange: (v: boolean) => void;
  audit?: FlagAuditEntry;
  warnings: DependencyWarning[];
  healthHint: { tone: "ok" | "warn" | "muted"; text: string } | null;
}) {
  const Icon = flagIcon(flagKey);
  return (
    <Card
      className={
        "group relative overflow-hidden p-0 transition-all duration-200 " +
        (checked
          ? "border-brand-accent/30 shadow-[0_0_0_1px_rgba(37,99,235,0.08),0_1px_2px_rgba(15,23,42,0.04)] hover:shadow-[0_0_0_1px_rgba(37,99,235,0.18),0_8px_24px_-8px_rgba(37,99,235,0.18)]"
          : "hover:border-border/80 hover:shadow-md")
      }
    >
      {/* Active glow stripe */}
      {checked && (
        <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-brand-accent/60 via-brand-accent/30 to-transparent" />
      )}
      <div className="flex items-start gap-4 p-5">
        {/* Icon lane */}
        <div
          className={
            "mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors " +
            (checked
              ? "bg-brand-accent/10 text-brand-accent"
              : "bg-surface-muted/70 text-ink-subtle")
          }
        >
          <Icon className="h-5 w-5" />
        </div>

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className={
                "text-sm font-semibold " + (checked ? "text-ink" : "text-ink-muted")
              }
            >
              {meta.label}
            </h3>
            <RuntimeBadge enabled={checked} />
            {changed && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                <Clock className="h-3 w-3" /> Unsaved
              </span>
            )}
          </div>
          <p
            className={
              "mt-1 text-sm " + (checked ? "text-ink-muted" : "text-ink-subtle")
            }
          >
            {meta.description}
          </p>

          {/* Separator + impact + health hint */}
          <div className="mt-3 space-y-2 border-t border-border/60 pt-3 text-xs">
            <p className="text-ink-subtle">
              <span className="font-medium text-ink-muted">When off:</span>{" "}
              {meta.impact}
            </p>
            {healthHint && (
              <p className="inline-flex items-center gap-1.5 rounded-md bg-surface-muted/60 px-2 py-1 text-[11px] text-ink-muted">
                <span
                  className={
                    "h-1.5 w-1.5 rounded-full " +
                    (healthHint.tone === "ok"
                      ? "bg-emerald-500"
                      : healthHint.tone === "warn"
                        ? "bg-amber-500"
                        : "bg-slate-400")
                  }
                />
                {healthHint.text}
              </p>
            )}
          </div>

          {/* Dependency warnings */}
          {warnings.length > 0 && (
            <div className="mt-3 space-y-2">
              {warnings.map((w, idx) => (
                <DependencyWarningRow key={`${w.flag}-${idx}`} warning={w} />
              ))}
            </div>
          )}

          {/* Audit footer */}
          {audit && (
            <div className="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-3 text-[11px] text-ink-subtle">
              <History className="h-3 w-3" />
              <span>
                Last changed by{" "}
                <span className="font-medium text-ink-muted">
                  {audit.actorName ?? audit.actorEmail ?? "—"}
                </span>{" "}
                <RelativeTime iso={audit.at} />
              </span>
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10px] tracking-tight text-ink-subtle">
                {audit.source}
              </span>
            </div>
          )}
        </div>

        {/* Toggle */}
        <Toggle
          checked={checked}
          disabled={busy}
          onChange={onChange}
          ariaLabel={`Toggle ${meta.label}`}
        />
      </div>
    </Card>
  );
}

function RuntimeBadge({ enabled }: { enabled: boolean }) {
  if (enabled) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        Live
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
      Disabled
    </span>
  );
}

function DependencyWarningRow({ warning }: { warning: DependencyWarning }) {
  const isWarn = warning.tone === "warning";
  const Icon = isWarn ? AlertTriangle : Info;
  return (
    <div
      className={
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] " +
        (isWarn
          ? "border-amber-200 bg-amber-50 text-amber-900"
          : "border-sky-200 bg-sky-50 text-sky-900")
      }
    >
      <Icon className={"mt-0.5 h-3.5 w-3.5 shrink-0 " + (isWarn ? "text-amber-600" : "text-sky-600")} />
      <div className="min-w-0 flex-1">
        <span>{warning.message}</span>
      </div>
      <Link
        href={warning.manageHref}
        className={
          "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium hover:underline " +
          (isWarn ? "text-amber-800" : "text-sky-800")
        }
      >
        {warning.manageLabel}
        <ExternalLink className="h-3 w-3" />
      </Link>
    </div>
  );
}

function RelativeTime({ iso }: { iso: string }) {
  const [text, setText] = React.useState(() => formatRelative(iso));
  React.useEffect(() => {
    const id = setInterval(() => setText(formatRelative(iso)), 60_000);
    return () => clearInterval(id);
  }, [iso]);
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {text}
    </time>
  );
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(1, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ─── Hero stat + system chip ──────────────────────────────────────────

function HeroStat({
  value,
  label,
  accent = "default",
}: {
  value: string;
  label: string;
  accent?: "default" | "amber" | "muted" | "violet";
}) {
  return (
    <div className="min-w-[88px] rounded-xl border border-border bg-surface px-3 py-2 text-left">
      <div
        className={
          "text-lg font-semibold tabular-nums " +
          (accent === "amber"
            ? "text-amber-700"
            : accent === "violet"
              ? "text-violet-700"
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

function OperationalChip({ item }: { item: OperationalHealthItem }) {
  const meta = chipVisual(item.status);
  const Icon = healthIcon(item.id);
  return (
    <span
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-medium " +
        meta.classes
      }
      title={item.detail}
    >
      <Icon className="h-3 w-3" />
      <span>{item.label}</span>
      <span className={"h-1.5 w-1.5 rounded-full " + meta.dot} />
    </span>
  );
}

function chipVisual(status: OperationalHealthItem["status"]) {
  switch (status) {
    case "ok":
      return {
        classes: "border-emerald-200 bg-emerald-50 text-emerald-800",
        dot: "bg-emerald-500",
      };
    case "degraded":
      return {
        classes: "border-amber-200 bg-amber-50 text-amber-900",
        dot: "bg-amber-500",
      };
    case "down":
      return {
        classes: "border-rose-200 bg-rose-50 text-rose-800",
        dot: "bg-rose-500",
      };
    case "muted":
      return {
        classes: "border-border bg-surface-muted text-ink-subtle",
        dot: "bg-slate-400",
      };
  }
}

function healthIcon(id: string) {
  switch (id) {
    case "booking-engine":
      return Zap;
    case "reminder-engine":
      return Bell;
    case "smtp":
      return Mail;
    case "calendar-oauth":
      return CalendarRange;
    case "webhook-delivery":
      return Webhook;
    default:
      return Server;
  }
}

// ─── External ref row ─────────────────────────────────────────────────

function ExternalRefRow({ ref_ }: { ref_: ExternalPolicyRef }) {
  const meta = externalRefVisual(ref_.status);
  const locked = ref_.planLocked;
  return (
    <Card
      className={
        "flex items-start gap-3 p-4 transition-colors " +
        (locked
          ? "border-violet-100/80 bg-gradient-to-br from-violet-50/40 via-surface to-surface hover:bg-violet-50/40"
          : "hover:bg-surface-muted/30")
      }
      title={locked ? "Upgrade required to enable" : undefined}
    >
      {/* Icon lane — Lock when plan-locked, otherwise status icon */}
      <div
        className={
          "mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg " +
          (locked ? "bg-violet-100/80 text-violet-700" : meta.iconWrap)
        }
      >
        {locked ? (
          <Lock className="h-4 w-4" />
        ) : (
          <meta.Icon className={"h-4 w-4 " + meta.iconColor} />
        )}
      </div>

      {/* Body */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              "text-sm font-semibold " + (locked ? "text-ink-muted" : "text-ink")
            }
          >
            {ref_.label}
          </span>
          <span
            className={
              "rounded-full px-2 py-0.5 text-[10px] font-medium " + meta.pill
            }
          >
            {meta.statusLabel}
          </span>
          {ref_.requiredPlan && (
            <PlanBadge plan={ref_.requiredPlan} locked={locked} />
          )}
          <span className="rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-medium text-ink-subtle">
            Managed elsewhere
          </span>
        </div>
        <p
          className={
            "mt-1 text-xs " + (locked ? "text-ink-subtle" : "text-ink-muted")
          }
        >
          {ref_.detail}
        </p>
      </div>

      {/* Disabled-style switch for locked items — visual cue that the
          capability cannot be toggled here. Pure decoration; no event
          handlers attached. */}
      {locked && (
        <div
          className="mr-1 hidden self-center sm:inline-flex"
          aria-hidden="true"
        >
          <span className="relative inline-flex h-6 w-11 cursor-not-allowed items-center rounded-full bg-slate-200 opacity-60">
            <span className="ml-0.5 inline-block h-5 w-5 rounded-full bg-white shadow" />
          </span>
        </div>
      )}

      {/* CTA */}
      <Link
        href={ref_.manageHref}
        className={
          "ml-2 inline-flex shrink-0 items-center gap-1 self-center rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-surface-muted " +
          (locked
            ? "border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100"
            : "border-border bg-surface text-ink")
        }
      >
        {locked && <Lock className="h-3 w-3" />}
        {ref_.manageLabel}
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </Card>
  );
}

function PlanBadge({
  plan,
  locked,
}: {
  plan: NonNullable<ExternalPolicyRef["requiredPlan"]>;
  locked: boolean;
}) {
  const styles = locked
    ? "border-violet-200 bg-violet-50 text-violet-700"
    : "border-emerald-200 bg-emerald-50 text-emerald-700";
  const label = plan.toUpperCase();
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide " +
        styles
      }
    >
      {locked && <Lock className="h-2.5 w-2.5" />}
      {label}
    </span>
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
        Icon: Lock,
        iconWrap: "bg-violet-50",
        iconColor: "text-violet-600",
        pill: "bg-violet-50 text-violet-700",
        statusLabel: "Upgrade required",
      };
    case "always_on":
      return {
        Icon: ShieldCheck,
        iconWrap: "bg-sky-50",
        iconColor: "text-sky-600",
        pill: "bg-sky-50 text-sky-700",
        statusLabel: "Always on",
      };
  }
}

// ─── Icon mapping ─────────────────────────────────────────────────────

function sectionIcon(id: FeatureSectionDef["id"]) {
  switch (id) {
    case "booking":
      return CheckCircle2;
    case "automation":
      return Mail;
    case "scheduling":
      return CalendarClock;
    case "branding":
      return Palette;
  }
}

function flagIcon(key: string) {
  switch (key) {
    case "reminders":
      return Bell;
    case "rescheduling":
      return CalendarDays;
    case "cancellations":
      return XCircle;
    case "intakeForms":
      return Shield;
    case "googleMeet":
      return Video;
    case "emailNotifications":
      return MailWarning;
    case "bookingBuffers":
      return Clock;
    case "webhookDelivery":
      return Webhook;
    default:
      return Globe;
  }
}

// Per-toggle health hint. Every line MUST reflect actual backend state —
// never a hard-coded "All systems normal" string.
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
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors " +
        (checked ? "bg-brand-accent" : "bg-slate-300") +
        (disabled ? " opacity-50" : "")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-5" : "translate-x-0.5")
        }
      />
    </button>
  );
}
