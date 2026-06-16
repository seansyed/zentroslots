"use client";

/**
 * Global AI Copilot — Phase 9A.
 *
 * Persistent floating operational intelligence surface mounted in
 * Shell so it appears across every dashboard workspace. The panel
 * synthesizes cross-module signals from /api/tenant/copilot/brief
 * and surfaces:
 *
 *   - Today's operational headline (the "daily brief")
 *   - Cross-module signal cards (calendar / appointments / customers
 *     / communications / tasks / analytics)
 *   - Quick-action navigation
 *
 * Design intent: an operational intelligence companion, NOT a
 * chatbot. No conversational UI, no input field, no support-bot
 * energy — just calm executive synthesis with ambient luxury.
 *
 * Motion: unified cubic-bezier(0.16, 1, 0.3, 1) curve to match the
 * rest of the platform's choreography.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Sparkles,
  X,
  CalendarRange,
  Users,
  MessageSquare,
  ListChecks,
  BarChart3,
  CalendarDays,
  Activity,
  ArrowUpRight,
  ChevronRight,
  RefreshCcw,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/cn";

// ─── Types matching /api/tenant/copilot/brief ───────────────────────

type Tone = "positive" | "warning" | "brand" | "neutral";
type Module = "calendar" | "appointments" | "customers" | "communications" | "tasks" | "analytics";

type Signal = {
  id: string;
  module: Module;
  tone: Tone;
  title: string;
  detail: string;
  href?: string;
  actionLabel?: string;
};

type QuickAction = {
  id: string;
  label: string;
  description: string;
  href: string;
  module: Module;
};

type Brief = {
  brief: {
    headline: string;
    tone: Tone;
    generatedAt: string;
    dayLabel: string;
  };
  metrics: {
    todayBookings: number;
    next7dBookings: number;
    prev7dCompleted: number;
    cancels48h: number;
    vips: number;
    dormantVips: number;
    openTasks: number;
    overdueTasks: number;
    comms24h: number;
    commsHealthPct: number;
    loadVsAvgPct: number;
    snapshotDays: number;
  };
  signals: Signal[];
  quickActions: QuickAction[];
};

const MODULE_ICON: Record<Module, LucideIcon> = {
  calendar: CalendarRange,
  appointments: CalendarDays,
  customers: Users,
  communications: MessageSquare,
  tasks: ListChecks,
  analytics: BarChart3,
};

// Surfaces where we deliberately hide the copilot. Login/onboarding
// shells render through different layouts so this is mostly defensive.
const HIDDEN_PATH_PREFIXES = ["/dashboard/login", "/login", "/reset-password", "/forgot-password"];

export default function GlobalCopilot() {
  const pathname = usePathname() ?? "";
  const reduce = useReducedMotion();
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<Brief | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = React.useState<number | null>(null);

  const fetchBrief = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tenant/copilot/brief", { cache: "no-store" });
      if (!res.ok) throw new Error(`Brief unavailable (${res.status})`);
      const json = (await res.json()) as Brief;
      setData(json);
      setLastLoadedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Brief unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy-load: fetch on first open. Refresh if older than 5 minutes
  // when the panel is re-opened so the briefing stays operational.
  React.useEffect(() => {
    if (!open) return;
    const stale = !lastLoadedAt || Date.now() - lastLoadedAt > 5 * 60_000;
    if (!data || stale) {
      void fetchBrief();
    }
  }, [open, data, lastLoadedAt, fetchBrief]);

  // Esc closes the panel
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (HIDDEN_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <>
      {/* Floating launcher */}
      <CopilotLauncher open={open} onToggle={() => setOpen((v) => !v)} reduce={!!reduce} />

      <AnimatePresence>
        {open && (
          <CopilotPanel
            key="copilot-panel"
            data={data}
            loading={loading}
            error={error}
            onClose={() => setOpen(false)}
            onRefresh={() => void fetchBrief()}
            reduce={!!reduce}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ─── Launcher ──────────────────────────────────────────────────────

function CopilotLauncher({
  open,
  onToggle,
  reduce,
}: {
  open: boolean;
  onToggle: () => void;
  reduce: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? "Close operational copilot" : "Open operational copilot"}
      className={cn(
        "group fixed bottom-5 right-5 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full",
        "bg-gradient-to-br from-brand-accent to-brand-hover text-white",
        // Phase 14D: softer base shadow + smaller glow → calmer idle state
        "shadow-[0_6px_18px_rgba(37,99,235,0.28)] ring-1 ring-brand-accent/25",
        "transition-all duration-[220ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        "hover:-translate-y-px hover:shadow-[0_10px_26px_rgba(37,99,235,0.36)]",
        "active:translate-y-0",
        "sm:bottom-6 sm:right-6 sm:h-13 sm:w-13",
      )}
      style={{ height: 52, width: 52 }}
    >
      {/* Pulse halo — calmer idle (Phase 14D) */}
      {!reduce && !open && (
        <>
          <span
            aria-hidden
            className="absolute inset-0 rounded-full bg-brand-accent/22 blur-md"
            style={{ animation: "zm-pulse-glow 2.6s cubic-bezier(0.16, 1, 0.3, 1) infinite" }}
          />
          <span
            aria-hidden
            className="absolute -inset-1 rounded-full"
            style={{
              background:
                "conic-gradient(from 0deg, rgba(37,99,235,0.22), rgba(16,185,129,0.16), rgba(37,99,235,0.22))",
              filter: "blur(8px)",
              opacity: 0.40,
            }}
          />
        </>
      )}
      <span className="relative">
        {open ? (
          <X className="h-5 w-5" strokeWidth={2} />
        ) : (
          <Sparkles className="h-5 w-5" strokeWidth={2} />
        )}
      </span>
      {/* Live presence dot */}
      {!open && (
        <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-3 w-3 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
          <span className="relative h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.65)] ring-2 ring-white" />
        </span>
      )}
    </button>
  );
}

// ─── Panel ─────────────────────────────────────────────────────────

function CopilotPanel({
  data,
  loading,
  error,
  onClose,
  onRefresh,
  reduce,
}: {
  data: Brief | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  reduce: boolean;
}) {
  return (
    <>
      {/* Mobile scrim — desktop hovers without scrim to stay calm */}
      <motion.div
        key="copilot-scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reduce ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
        className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-[2px] sm:hidden"
        onClick={onClose}
        aria-hidden
      />

      <motion.aside
        key="copilot-panel"
        role="dialog"
        aria-label="Operational copilot"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.985 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.985 }}
        transition={{ duration: reduce ? 0 : 0.32, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "fixed z-50 overflow-hidden rounded-3xl border border-border bg-surface shadow-[0_28px_80px_rgba(15,23,42,0.22)]",
          // Mobile: bottom sheet
          "inset-x-3 bottom-3 max-h-[78vh] flex flex-col",
          // Desktop: floating panel anchored above the launcher
          "sm:inset-x-auto sm:bottom-24 sm:right-6 sm:w-[420px] sm:max-h-[calc(100vh-160px)]",
        )}
      >
        {/* Ambient atmospheric depth */}
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-accent/[0.16] blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -left-16 -bottom-16 h-48 w-48 rounded-full bg-emerald-200/[0.16] blur-3xl" />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent"
        />
        <span
          aria-hidden
          className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-white/25 to-transparent"
        />

        {/* Header */}
        <header className="relative flex items-start justify-between gap-3 border-b border-border/70 px-4 py-3.5 sm:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_14px_rgba(37,99,235,0.40)]">
              <Sparkles className="h-4 w-4" strokeWidth={2} />
              <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
                <span className="relative h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-surface" />
              </span>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                Operational copilot
              </div>
              <div className="text-[13px] font-semibold tracking-tight text-ink">
                Today&rsquo;s briefing
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh brief"
              disabled={loading}
              className={cn(
                "inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink",
                loading && "opacity-50",
              )}
            >
              <RefreshCcw className={cn("h-3.5 w-3.5", loading && "animate-spin")} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close copilot"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        </header>

        {/* Scrollable body */}
        <div className="relative flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {/* Brief headline */}
          <BriefHeadline data={data} loading={loading} error={error} />

          {/* Signals */}
          {data && data.signals.length > 0 && (
            <section className="mt-5">
              <SectionLabel>Cross-module signals</SectionLabel>
              <ul className="mt-2 space-y-2">
                {data.signals.map((s) => (
                  <li key={s.id}>
                    <SignalCard signal={s} onNavigate={onClose} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Metrics quick row */}
          {data && (
            <section className="mt-5">
              <SectionLabel>Today at a glance</SectionLabel>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <MiniMetric label="Bookings today" value={String(data.metrics.todayBookings)} />
                <MiniMetric label="Next 7 days" value={String(data.metrics.next7dBookings)} />
                <MiniMetric
                  label="Overdue tasks"
                  value={String(data.metrics.overdueTasks)}
                  tone={data.metrics.overdueTasks > 0 ? "warning" : "neutral"}
                />
                <MiniMetric
                  label="Comms delivery"
                  value={data.metrics.comms24h > 0 ? `${data.metrics.commsHealthPct}%` : "—"}
                  tone={data.metrics.commsHealthPct < 90 && data.metrics.comms24h > 0 ? "warning" : "positive"}
                />
              </div>
            </section>
          )}

          {/* Quick actions */}
          {data && data.quickActions.length > 0 && (
            <section className="mt-5">
              <SectionLabel>Quick actions</SectionLabel>
              <ul className="mt-2 space-y-1.5">
                {data.quickActions.map((q) => (
                  <li key={q.id}>
                    <QuickActionRow action={q} onNavigate={onClose} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Footer */}
        {data && (
          <footer className="relative border-t border-border/60 bg-surface/80 px-4 py-2 backdrop-blur-sm sm:px-5">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-subtle">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                Live synthesis
              </span>
              <span>{relativeTime(data.brief.generatedAt)}</span>
            </div>
          </footer>
        )}
      </motion.aside>
    </>
  );
}

// ─── Headline ──────────────────────────────────────────────────────

function BriefHeadline({ data, loading, error }: { data: Brief | null; loading: boolean; error: string | null }) {
  const toneCls = (() => {
    if (!data) return "from-brand-subtle/40 via-surface to-surface ring-brand-accent/15";
    switch (data.brief.tone) {
      case "positive": return "from-emerald-50/60 via-surface to-surface ring-emerald-200/40";
      case "warning":  return "from-amber-50/60 via-surface to-surface ring-amber-200/40";
      case "neutral":  return "from-surface via-surface to-surface ring-border/60";
      default:         return "from-brand-subtle/40 via-surface to-surface ring-brand-accent/15";
    }
  })();

  return (
    <div className={cn(
      "relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br p-3.5 ring-1",
      toneCls,
    )}>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
      />
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
        Operational briefing
        {data && <span className="ml-1 text-ink-subtle">&middot; {data.brief.dayLabel}</span>}
      </div>
      {loading && !data && (
        <div className="mt-2 space-y-2">
          <div className="h-4 w-3/4 animate-pulse rounded bg-surface-inset" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-surface-inset" />
        </div>
      )}
      {error && !data && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          Brief unavailable right now. Operational data will reload on next open.
        </p>
      )}
      {data && (
        <p className="mt-1.5 text-[13.5px] font-semibold leading-snug tracking-tight text-ink">
          {data.brief.headline}
        </p>
      )}
    </div>
  );
}

// ─── Signal card ───────────────────────────────────────────────────

function SignalCard({
  signal,
  onNavigate,
}: {
  signal: Signal;
  onNavigate?: () => void;
}) {
  const Icon = MODULE_ICON[signal.module] ?? Activity;
  const rail =
    signal.tone === "warning"  ? "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.35)]" :
    signal.tone === "positive" ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.35)]" :
    signal.tone === "brand"    ? "bg-brand-accent shadow-[0_0_8px_rgba(37,99,235,0.35)]" :
                                  "bg-slate-300";
  const tint =
    signal.tone === "warning"  ? "bg-amber-50/30 ring-amber-200/30" :
    signal.tone === "positive" ? "bg-emerald-50/30 ring-emerald-200/30" :
    signal.tone === "brand"    ? "bg-brand-subtle/30 ring-brand-accent/15" :
                                  "ring-border/40";
  const iconBg =
    signal.tone === "warning"  ? "bg-amber-50 text-amber-700" :
    signal.tone === "positive" ? "bg-emerald-50 text-emerald-700" :
    signal.tone === "brand"    ? "bg-brand-subtle text-brand-accent" :
                                  "bg-surface-inset text-ink-muted";

  const Wrap: React.ElementType = signal.href ? Link : "div";
  const wrapProps: Record<string, unknown> = signal.href ? { href: signal.href, onClick: onNavigate } : {};

  return (
    <Wrap
      {...wrapProps}
      className={cn(
        "group relative block overflow-hidden rounded-xl border border-border bg-surface p-3 ring-1 transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
        tint,
        signal.href && "hover:-translate-y-0.5 hover:border-border-strong hover:shadow-lift",
      )}
    >
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5 rounded-l-xl", rail)} />
      <div className="flex items-start gap-2.5 pl-1.5">
        <div className={cn("inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-border/40", iconBg)}>
          <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
              {signal.module}
            </span>
          </div>
          <h4 className="text-[12.5px] font-semibold leading-snug tracking-tight text-ink">{signal.title}</h4>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-muted">{signal.detail}</p>
        </div>
        {signal.href && (
          <ArrowUpRight
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-brand-accent"
            strokeWidth={1.75}
          />
        )}
      </div>
    </Wrap>
  );
}

// ─── Mini metric tile ──────────────────────────────────────────────

function MiniMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "positive" | "warning";
}) {
  const tint =
    tone === "positive" ? "bg-emerald-50/40 ring-emerald-200/30" :
    tone === "warning"  ? "bg-amber-50/40 ring-amber-200/30"   :
                          "bg-surface-inset/40 ring-border/40";
  return (
    <div className={cn(
      "relative overflow-hidden rounded-lg border border-border bg-surface p-2.5 ring-1",
      tint,
    )}>
      <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</div>
      <div className="mt-1 text-[18px] font-semibold leading-none tabular-nums tracking-tight text-ink">{value}</div>
    </div>
  );
}

// ─── Quick action row ──────────────────────────────────────────────

function QuickActionRow({
  action,
  onNavigate,
}: {
  action: QuickAction;
  onNavigate?: () => void;
}) {
  const Icon = MODULE_ICON[action.module] ?? Activity;
  return (
    <Link
      href={action.href}
      onClick={onNavigate}
      className="group flex items-center gap-2.5 rounded-xl border border-border bg-surface px-3 py-2 transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface-inset/30 hover:shadow-soft"
    >
      <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-inset text-ink-muted ring-1 ring-border/40">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-semibold tracking-tight text-ink">{action.label}</div>
        <div className="truncate text-[11px] text-ink-muted">{action.description}</div>
      </div>
      <ChevronRight
        className="h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-0.5 group-hover:text-brand-accent"
        strokeWidth={1.75}
      />
    </Link>
  );
}

// ─── Section label ─────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">{children}</div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "Synced just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `Synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `Synced ${hours}h ago`;
}
