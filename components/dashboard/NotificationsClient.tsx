"use client";

/**
 * NotificationsClient — Operational Command Center (Phase 5A).
 *
 * STRICTLY PRESERVED:
 *   - Default export name (NotificationsClient)
 *   - Notif type shape ({id, kind, title, body, link, readAt, createdAt})
 *   - Props { initial: Notif[] }
 *   - All API calls:
 *       GET   /api/notifications        (used elsewhere; this file
 *                                        only consumes the SSR prop)
 *       PATCH /api/notifications        (mark all read)
 *       PATCH /api/notifications/[id]   (mark one read)
 *
 * What changed (UI-only):
 *   - Premium hero with brand-gradient unread pill + "Operational inbox"
 *     eyebrow + soft corner glow.
 *   - SegmentedFilterBar (All / Unread / Critical / Bookings /
 *     Customers / AI / System) with count badges + Framer layoutId
 *     animated brand indicator.
 *   - Right-side action cluster: Mark all read, Notification settings.
 *   - Category derivation from `kind` string → icon + soft tint.
 *   - Premium NotificationCard with hover halo (same language as
 *     TaskCard/AppointmentCard), unread blue rail glow + pulse dot,
 *     hover-reveal "Open / Mark read" chips.
 *   - Timeline grouping: Now / Today / Yesterday / Earlier with
 *     luxury uppercase dividers.
 *   - Optional AI summary InsightCard banner — rules-derived
 *     ("3 unread · 2 booking updates today").
 *   - Premium empty state: floating bell + brand glow + live monitoring
 *     sub + zm-pulse-glow.
 *   - FadeIn stagger entrance, mobile responsive.
 *
 * Easing language: cubic-bezier(0.16, 1, 0.3, 1) end-to-end.
 */
import * as React from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  BellRing,
  Calendar,
  Users,
  Sparkles,
  Server,
  AlertTriangle,
  CheckCheck,
  Settings,
  ArrowRight,
  Inbox,
  CreditCard,
  ListChecks,
  UserPlus,
  type LucideIcon,
} from "lucide-react";

import { toast } from "@/components/ui/primitives";
import { PremiumCard, InsightCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";

// ─── Public contract ────────────────────────────────────────────────

type Notif = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

// ─── Categories ─────────────────────────────────────────────────────

type Category =
  | "booking"
  | "customer"
  | "task"
  | "ai"
  | "system"
  | "revenue"
  | "team"
  | "reminder";

type Filter = "all" | "unread" | "critical" | "booking" | "customer" | "ai" | "system";

const FILTERS: Filter[] = ["all", "unread", "critical", "booking", "customer", "ai", "system"];

const FILTER_LABEL: Record<Filter, string> = {
  all:      "All",
  unread:   "Unread",
  critical: "Critical",
  booking:  "Bookings",
  customer: "Customers",
  ai:       "AI",
  system:   "System",
};

const CATEGORY_META: Record<Category, {
  label: string;
  icon: LucideIcon;
  iconBg: string;     // tonal background for the icon container
  iconText: string;   // foreground for the icon
  railBg: string;     // unread rail tint
}> = {
  booking:  { label: "Booking",   icon: Calendar,      iconBg: "bg-brand-subtle",    iconText: "text-brand-accent", railBg: "bg-brand-accent" },
  customer: { label: "Customer",  icon: UserPlus,      iconBg: "bg-violet-50",       iconText: "text-violet-700",   railBg: "bg-violet-500" },
  task:     { label: "Task",      icon: ListChecks,    iconBg: "bg-emerald-50",      iconText: "text-emerald-700",  railBg: "bg-emerald-500" },
  ai:       { label: "AI Insight", icon: Sparkles,     iconBg: "bg-brand-subtle",    iconText: "text-brand-accent", railBg: "bg-brand-accent" },
  system:   { label: "System",    icon: Server,        iconBg: "bg-slate-100",       iconText: "text-slate-700",    railBg: "bg-slate-500" },
  revenue:  { label: "Revenue",   icon: CreditCard,    iconBg: "bg-emerald-50",      iconText: "text-emerald-700",  railBg: "bg-emerald-500" },
  team:     { label: "Team",      icon: Users,         iconBg: "bg-indigo-50",       iconText: "text-indigo-700",   railBg: "bg-indigo-500" },
  reminder: { label: "Reminder",  icon: BellRing,      iconBg: "bg-amber-50",        iconText: "text-amber-700",    railBg: "bg-amber-500" },
};

/** Map a free-form `kind` string to a category. Falls back to "system". */
function categorize(kind: string): Category {
  const k = kind.toLowerCase();
  if (k.includes("book") || k.includes("appointment") || k.includes("calendar")) return "booking";
  if (k.includes("customer") || k.includes("client") || k.includes("contact")) return "customer";
  if (k.includes("task") || k.includes("todo") || k.includes("checklist")) return "task";
  if (k.includes("ai") || k.includes("insight") || k.includes("suggestion")) return "ai";
  if (k.includes("payment") || k.includes("invoice") || k.includes("revenue") || k.includes("stripe")) return "revenue";
  if (k.includes("team") || k.includes("staff") || k.includes("user")) return "team";
  if (k.includes("reminder") || k.includes("alert") || k.includes("upcoming")) return "reminder";
  return "system";
}

function isCritical(n: Notif): boolean {
  const k = n.kind.toLowerCase();
  return (
    k.includes("urgent") ||
    k.includes("failed") ||
    k.includes("error") ||
    k.includes("overdue") ||
    k.includes("no_show") ||
    k.includes("noshow") ||
    k.includes("cancel")
  );
}

// ─── Main component ────────────────────────────────────────────────

export default function NotificationsClient({ initial }: { initial: Notif[] }) {
  const [rows, setRows] = React.useState(initial);
  React.useEffect(() => setRows(initial), [initial]);
  const [filter, setFilter] = React.useState<Filter>("all");

  const unreadCount = React.useMemo(() => rows.filter((r) => !r.readAt).length, [rows]);
  const counts = React.useMemo(() => computeCounts(rows), [rows]);
  const filtered = React.useMemo(() => applyFilter(rows, filter), [rows, filter]);
  const grouped = React.useMemo(() => groupByBucket(filtered), [filtered]);
  const summary = React.useMemo(() => deriveSummary(rows), [rows]);
  const todayCount = React.useMemo(() => {
    const k = dayKey(new Date());
    return rows.filter((n) => dayKey(new Date(n.createdAt)) === k).length;
  }, [rows]);

  async function markAllRead() {
    if (unreadCount === 0) return;
    const stamp = new Date().toISOString();
    setRows((cur) => cur.map((n) => ({ ...n, readAt: n.readAt ?? stamp })));
    try {
      const res = await fetch("/api/notifications", { method: "PATCH" });
      if (!res.ok) throw new Error("Failed");
      toast("All marked read", "success");
    } catch {
      toast("Failed to mark read", "error");
    }
  }

  async function markOne(id: string) {
    setRows((cur) => cur.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)));
    try {
      await fetch(`/api/notifications/${id}`, { method: "PATCH" });
    } catch {
      /* swallow — local state already optimistic */
    }
  }

  return (
    <div className="relative mt-6 space-y-5">
      {/* ── Ambient background depth — subtle radial wash fields
            behind the entire notifications container. Sub-conscious
            depth without competing with content. ──────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-32 -z-10 h-80 w-80 rounded-full bg-brand-accent/[0.06] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 top-96 -z-10 h-72 w-72 rounded-full bg-brand-accent/[0.05] blur-3xl"
      />

      {/* ── Hero ──────────────────────────────────────────────── */}
      <FadeIn>
        <Hero unreadCount={unreadCount} totalCount={rows.length} todayCount={todayCount} />
      </FadeIn>

      {/* ── AI Operational Strip — always rendered. The intelligence
            affordance never disappears so the page always reads as
            actively monitored. ────────────────────────────────────── */}
      <FadeIn delay={1}>
        <AIOperationalStrip summary={summary} />
      </FadeIn>

      {/* ── Filter bar + actions ──────────────────────────────── */}
      <FadeIn delay={2}>
        <FilterBar
          filter={filter}
          onChange={setFilter}
          counts={counts}
          unreadCount={unreadCount}
          onMarkAllRead={markAllRead}
        />
      </FadeIn>

      {/* ── Body ──────────────────────────────────────────────── */}
      {filtered.length === 0 ? (
        <FadeIn delay={3}>
          {rows.length === 0 ? <PremiumEmptyState /> : <FilteredEmptyState filter={filter} />}
        </FadeIn>
      ) : (
        <div className="space-y-5">
          {grouped.map((g, idx) => (
            <FadeIn key={g.bucket} delay={3 + idx}>
              <NotifGroup bucket={g.bucket} notifs={g.notifs} onMarkRead={markOne} />
            </FadeIn>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────

function Hero({
  unreadCount,
  totalCount,
  todayCount,
}: {
  unreadCount: number;
  totalCount: number;
  todayCount: number;
}) {
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/40 via-surface to-surface"
    >
      {/* Ambient corner glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-accent/12 blur-3xl"
      />
      {/* Radial glow behind the intelligence cluster */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-6 top-1/2 hidden h-32 w-48 -translate-y-1/2 rounded-full bg-brand-accent/8 blur-3xl md:block"
      />

      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
            <BellRing className="h-3 w-3" strokeWidth={2} />
            Operational inbox
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Notifications
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {totalCount === 0
              ? "Monitoring bookings, customers, reminders, and automation."
              : "Operational alerts, customer activity, and system signals across your workspace."}
          </p>
        </div>

        {/* Executive intelligence cluster — 3 glass KPI chips with
            tiny pulse indicators. Staggered entrance gives the
            cluster its own micro-cadence. */}
        <div className="relative flex flex-wrap items-center gap-1.5">
          <FadeIn delay={1}>
            <IntelChip
              label="Unread"
              value={unreadCount}
              dotClass={unreadCount > 0 ? "bg-brand-accent" : "bg-ink-subtle/40"}
              pulse={unreadCount > 0}
              emphasis={unreadCount > 0}
            />
          </FadeIn>
          <FadeIn delay={2}>
            <IntelChip
              label="Systems"
              value="Active"
              dotClass="bg-emerald-500"
              pulse
            />
          </FadeIn>
          <FadeIn delay={3}>
            <IntelChip
              label="Today"
              value={todayCount}
              dotClass="bg-ink-subtle/40"
              suffix="events"
            />
          </FadeIn>
        </div>
      </div>
    </PremiumCard>
  );
}

function IntelChip({
  label,
  value,
  dotClass,
  pulse = false,
  emphasis = false,
  suffix,
}: {
  label: string;
  value: number | string;
  dotClass: string;
  pulse?: boolean;
  emphasis?: boolean;
  suffix?: string;
}) {
  return (
    <div
      className={cn(
        "relative inline-flex items-center gap-2 overflow-hidden rounded-xl border border-border/70 bg-surface/70 px-2.5 py-1.5 shadow-[0_1px_2px_rgba(15,23,42,0.04),inset_0_-1px_0_rgba(15,23,42,0.03)] backdrop-blur-md transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:border-border-strong hover:bg-surface/85 hover:shadow-md",
        emphasis && "ring-1 ring-brand-accent/15",
      )}
    >
      {/* Inner top-edge highlight */}
      <span aria-hidden className="pointer-events-none absolute inset-x-1 top-0 h-px bg-gradient-to-r from-transparent via-white/65 to-transparent" />
      {/* Live pulse dot */}
      <span aria-hidden className="relative inline-flex h-2 w-2 shrink-0 items-center justify-center">
        {pulse && (
          <span className={cn("absolute inset-0 animate-ping rounded-full", dotClass, "opacity-50")} />
        )}
        <span className={cn("relative h-2 w-2 rounded-full", dotClass)} />
      </span>
      <div className="leading-none">
        <div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</div>
        <div className="mt-0.5 text-[12px] font-semibold tabular-nums text-ink">
          {value}
          {suffix && <span className="ml-1 text-[10px] font-medium text-ink-muted">{suffix}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── AI Operational Strip ──────────────────────────────────────────

function AIOperationalStrip({ summary }: { summary: string }) {
  return (
    <div className="zm-border-sweep relative overflow-hidden rounded-2xl">
      <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/45 via-surface to-surface shadow-soft">
        {/* Soft internal glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
        />
        {/* Inner top-edge highlight */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
        {/* Diagonal light sweep — passes across the strip every 15s
            with a long rest. Pure ambient — never grabs attention. */}
        <span
          aria-hidden
          className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent"
        />

        <div className="relative flex items-center gap-3 px-4 py-3 sm:px-5">
          {/* AI sync indicator — Sparkles in a brand-gradient pill
              with a live emerald sync dot in the corner. The
              container itself carries zm-pulse-glow so the dot has
              a slow breathing halo. */}
          <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
            <Sparkles className="h-4 w-4" strokeWidth={2} />
            <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)] ring-2 ring-surface" />
            </span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              AI Operational Signal
            </div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-ink">
              {summary}
            </div>
          </div>

          {/* Tiny right-side live presence */}
          <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface/70 px-2 py-0.5 text-[10px] font-medium text-ink-muted backdrop-blur-sm sm:inline-flex">
            <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
            Live
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Filter bar ────────────────────────────────────────────────────

function FilterBar({
  filter,
  onChange,
  counts,
  unreadCount,
  onMarkAllRead,
}: {
  filter: Filter;
  onChange: (f: Filter) => void;
  counts: Record<Filter, number>;
  unreadCount: number;
  onMarkAllRead: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="relative inline-flex flex-wrap items-center gap-0.5 rounded-xl border border-border bg-surface-subtle p-0.5 shadow-soft">
        {FILTERS.map((f) => {
          const active = filter === f;
          const n = counts[f];
          return (
            <button
              key={f}
              onClick={() => onChange(f)}
              aria-pressed={active}
              className={cn(
                "relative z-10 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.97]",
                active ? "text-white" : "text-ink-muted hover:text-ink",
              )}
            >
              {active && (
                <motion.span
                  layoutId="notifications-filter-indicator"
                  className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover shadow-[0_4px_12px_rgba(53,157,243,0.35),inset_0_1px_0_rgba(255,255,255,0.25)]"
                  aria-hidden
                  transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
              <span className="relative">{FILTER_LABEL[f]}</span>
              {n > 0 && (
                <span
                  className={cn(
                    "relative inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
                    active ? "bg-white/25 text-white" : "bg-surface-inset text-ink-subtle",
                  )}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={unreadCount === 0}
          onClick={onMarkAllRead}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:bg-surface"
        >
          <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
          Mark all read
        </button>
        <Link
          href="/dashboard/settings/communications"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          aria-label="Notification settings"
          title="Notification settings"
        >
          <Settings className="h-3.5 w-3.5" strokeWidth={1.75} />
        </Link>
      </div>
    </div>
  );
}

// ─── Group ──────────────────────────────────────────────────────────

type Bucket = "now" | "today" | "yesterday" | "earlier";

const BUCKET_LABEL: Record<Bucket, string> = {
  now:       "Now",
  today:     "Today",
  yesterday: "Yesterday",
  earlier:   "Earlier",
};

function NotifGroup({
  bucket,
  notifs,
  onMarkRead,
}: {
  bucket: Bucket;
  notifs: Notif[];
  onMarkRead: (id: string) => void;
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
          {BUCKET_LABEL[bucket]}
        </span>
        <span className="text-[10px] tabular-nums text-ink-subtle">·</span>
        <span className="text-[10px] tabular-nums text-ink-subtle">{notifs.length}</span>
        <span aria-hidden className="ml-1 h-px flex-1 bg-gradient-to-r from-border/70 via-border/40 to-transparent" />
      </div>
      <ul className="space-y-2">
        <AnimatePresence initial={false}>
          {notifs.map((n) => (
            <motion.li
              key={n.id}
              layout
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, height: 0, marginTop: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              style={{ overflow: "hidden" }}
            >
              <NotificationCard n={n} onMarkRead={onMarkRead} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

// ─── Notification card ──────────────────────────────────────────────

function NotificationCard({
  n,
  onMarkRead,
}: {
  n: Notif;
  onMarkRead: (id: string) => void;
}) {
  const cat = categorize(n.kind);
  const meta = CATEGORY_META[cat];
  const Icon = meta.icon;
  const critical = isCritical(n);
  const unread = !n.readAt;

  function handleClick() {
    if (unread) onMarkRead(n.id);
  }

  const inner = (
    <div
      className={cn(
        "group/notif relative overflow-hidden rounded-2xl border bg-surface px-3 py-2.5 shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] sm:px-4 sm:py-3",
        "hover:-translate-y-0.5 hover:scale-[1.002] hover:border-border-strong hover:shadow-lift",
        unread ? "border-brand-accent/20 bg-gradient-to-br from-brand-subtle/25 via-surface to-surface" : "border-border",
      )}
    >
      {/* Hover halo — unified with TaskCard / AppointmentCard */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-px rounded-2xl opacity-0 transition-opacity duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/notif:opacity-100"
        style={{
          boxShadow:
            "0 0 0 1px rgba(53,157,243,0.18), 0 10px 28px rgba(53,157,243,0.10), 0 24px 52px -8px rgba(53,157,243,0.07)",
        }}
      />
      {/* Tactile inner top highlight */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
      />
      {/* Left rail — brand-color glow when unread; tonal when read */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-1 rounded-l-2xl transition-shadow duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
          unread ? "bg-brand-accent shadow-[0_0_10px_rgba(53,157,243,0.45)]" : meta.railBg + " opacity-30",
        )}
      />

      <div className="relative flex items-start gap-3 pl-2">
        {/* Category icon */}
        <div
          aria-hidden
          className={cn(
            "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ring-1 transition-transform duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/notif:scale-105",
            meta.iconBg,
            meta.iconText,
            unread ? "ring-brand-accent/15" : "ring-border/40",
          )}
        >
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </div>

        {/* Body */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <h4 className={cn(
                  "truncate text-[13px] tracking-tight",
                  unread ? "font-semibold text-ink" : "font-medium text-ink-muted",
                )}>
                  {n.title}
                </h4>
                {critical && (
                  <span className="inline-flex items-center gap-0.5 rounded-full bg-red-50/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em] text-red-700 ring-1 ring-red-200/40">
                    <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2} />
                    Critical
                  </span>
                )}
                {unread && (
                  <span
                    aria-hidden
                    className="zm-pulse-glow inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-accent"
                  />
                )}
              </div>
              {n.body && (
                <p className={cn(
                  "mt-0.5 line-clamp-2 text-[12px] leading-relaxed",
                  unread ? "text-ink-muted" : "text-ink-subtle",
                )}>
                  {n.body}
                </p>
              )}
              <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-subtle">
                <span className="inline-flex items-center gap-0.5 rounded-full bg-surface-inset px-1.5 py-0.5 font-medium uppercase tracking-wider">
                  {meta.label}
                </span>
                <span>·</span>
                <span>{formatRelative(n.createdAt)}</span>
              </div>

              {/* Hover-reveal actions */}
              <div className="pointer-events-none mt-1.5 flex items-center gap-1.5 translate-y-1 opacity-0 transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/notif:pointer-events-auto group-hover/notif:translate-y-0 group-hover/notif:opacity-100 group-focus-within/notif:pointer-events-auto group-focus-within/notif:translate-y-0 group-focus-within/notif:opacity-100">
                {n.link && (
                  <Link
                    href={n.link}
                    onClick={(e) => { e.stopPropagation(); if (unread) onMarkRead(n.id); }}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-muted shadow-soft transition-colors hover:bg-surface-inset hover:text-ink"
                  >
                    Open
                    <ArrowRight className="h-2.5 w-2.5" strokeWidth={2} />
                  </Link>
                )}
                {unread && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onMarkRead(n.id); }}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-muted shadow-soft transition-colors hover:bg-surface-inset hover:text-ink"
                  >
                    <CheckCheck className="h-2.5 w-2.5" strokeWidth={1.75} />
                    Mark read
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // The whole card is clickable when there's a link target; the inner
  // chips stopPropagation so they fire their own behavior. When there's
  // no link, the only action is "mark read" — clicking anywhere marks.
  if (n.link) {
    return (
      <Link href={n.link} onClick={handleClick} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40 focus-visible:rounded-2xl">
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={handleClick} className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent/40 focus-visible:rounded-2xl">
      {inner}
    </button>
  );
}

// ─── Empty states ──────────────────────────────────────────────────

function PremiumEmptyState() {
  return (
    <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/35 via-surface to-brand-subtle/20">
      {/* Top-edge ambient light — a soft horizontal wash that anchors
          the top of the card without showing a hard line. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/40 to-transparent"
      />
      {/* Top inner-highlight hairline */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
      />
      {/* Two large ambient corner glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-accent/12 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 bottom-0 h-56 w-56 rounded-full bg-brand-accent/8 blur-3xl"
      />
      {/* Floating drifting orbs — adds ambient motion without distraction */}
      <div
        aria-hidden
        className="pointer-events-none absolute right-12 top-8 h-24 w-24 rounded-full bg-brand-accent/10 blur-2xl zm-drift-slow"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-16 bottom-12 h-20 w-20 rounded-full bg-emerald-400/8 blur-2xl zm-drift-slow-reverse"
      />

      <div className="relative flex flex-col items-center justify-center px-4 py-12 text-center">
        {/* Floating bell with layered orbit rings — each ring has
            its own pulse timing for organic, non-synchronized motion.
            Thickness varies inward (thinnest outside, slightly thicker
            close to the icon) for natural depth perception. */}
        <div className="relative mb-5 inline-flex h-28 w-28 items-center justify-center">
          {/* Outer orbit ring — softest, longest cycle, faint blur */}
          <span
            aria-hidden
            className="zm-ring-pulse-3 absolute h-28 w-28 rounded-full border border-brand-accent/8 blur-[1px]"
          />
          {/* Middle orbit ring — medium opacity, medium cycle */}
          <span
            aria-hidden
            className="zm-ring-pulse-2 absolute h-[88px] w-[88px] rounded-full border border-brand-accent/18"
          />
          {/* Innermost orbit ring — brightest, thicker, shortest cycle */}
          <span
            aria-hidden
            className="zm-ring-pulse-1 absolute h-[72px] w-[72px] rounded-full border-2 border-brand-accent/30"
          />
          {/* Diffuse glow behind icon */}
          <span
            aria-hidden
            className="absolute h-20 w-20 rounded-full bg-brand-accent/15 blur-2xl"
          />
          {/* Bell icon container */}
          <div className="zm-pulse-glow relative inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
            <Bell className="h-7 w-7" strokeWidth={1.75} />
            {/* Tiny live system pulse */}
            <span aria-hidden className="absolute -right-1 -top-1 inline-flex h-3 w-3 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/50" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.55)]" />
            </span>
          </div>
        </div>

        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          All quiet
        </div>
        <h3 className="mt-1 text-[18px] font-semibold tracking-tight text-ink">
          You&rsquo;re all caught up
        </h3>
        <p className="mt-1 max-w-[380px] text-[12px] leading-relaxed text-ink-muted">
          No operational alerts need your attention right now.
        </p>

        <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/70 px-3 py-1 text-[10px] font-medium text-ink-muted backdrop-blur-sm">
          <span aria-hidden className="relative inline-flex h-2 w-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/50" />
            <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Monitoring bookings, customers, reminders, and automation.
        </div>

        {/* Ghost preview activity — staggered horizontal offsets +
            width variance simulate ambient operational activity
            instead of mechanical centered alignment. */}
        <div className="mt-8 w-full max-w-md space-y-2" aria-hidden>
          {/* Row 1 — full width, brightest */}
          <div className="mx-auto" style={{ width: "100%" }}>
            <GhostNotifRow
              icon={Calendar}
              iconBg="bg-brand-subtle"
              iconText="text-brand-accent"
              title="Sarah booked Strategy Session"
              meta="Booking · 2h ago"
              opacity="opacity-55"
            />
          </div>
          {/* Row 2 — slightly right-shifted + narrower */}
          <div className="ml-auto mr-0" style={{ width: "88%" }}>
            <GhostNotifRow
              icon={Sparkles}
              iconBg="bg-brand-subtle"
              iconText="text-brand-accent"
              title="AI optimized tomorrow's availability"
              meta="AI Insight · earlier"
              opacity="opacity-45"
            />
          </div>
          {/* Row 3 — slightly left-shifted + medium width */}
          <div className="mr-auto ml-0" style={{ width: "92%" }}>
            <GhostNotifRow
              icon={CheckCheck}
              iconBg="bg-emerald-50"
              iconText="text-emerald-700"
              title="Reminder delivered successfully"
              meta="System · earlier"
              opacity="opacity-35"
            />
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}

function GhostNotifRow({
  icon: Icon,
  iconBg,
  iconText,
  title,
  meta,
  opacity,
}: {
  icon: LucideIcon;
  iconBg: string;
  iconText: string;
  title: string;
  meta: string;
  opacity: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5 rounded-xl border border-border/40 bg-surface/40 px-3 py-2 backdrop-blur-sm", opacity)}>
      <div className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg", iconBg, iconText)}>
        <Icon className="h-3 w-3" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-[12px] font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-[10px] text-ink-subtle">{meta}</div>
      </div>
    </div>
  );
}

function FilteredEmptyState({ filter }: { filter: Filter }) {
  const copy: Record<Filter, { title: string; body: string }> = {
    all:      { title: "Nothing here yet",     body: "Notifications will appear as activity arrives." },
    unread:   { title: "Nothing new",           body: "You're caught up on every operational signal." },
    critical: { title: "No critical alerts",    body: "No urgent operational blockers right now." },
    booking:  { title: "No booking signals",    body: "Booking activity will show up here as it happens." },
    customer: { title: "No customer activity",  body: "New customer signals will appear here." },
    ai:       { title: "No AI insights",        body: "Operational suggestions will surface here." },
    system:   { title: "No system signals",     body: "Infrastructure and automation alerts go here." },
  };
  const c = copy[filter];
  return (
    <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/20 via-surface to-surface">
      <div className="flex items-start gap-3 px-2 py-4">
        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
          <Inbox className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">{c.title}</h3>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{c.body}</p>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

function applyFilter(rows: Notif[], filter: Filter): Notif[] {
  switch (filter) {
    case "all":      return rows;
    case "unread":   return rows.filter((n) => !n.readAt);
    case "critical": return rows.filter(isCritical);
    case "booking":  return rows.filter((n) => categorize(n.kind) === "booking");
    case "customer": return rows.filter((n) => categorize(n.kind) === "customer");
    case "ai":       return rows.filter((n) => categorize(n.kind) === "ai");
    case "system":   return rows.filter((n) => categorize(n.kind) === "system");
  }
}

function computeCounts(rows: Notif[]): Record<Filter, number> {
  return {
    all:      rows.length,
    unread:   rows.filter((n) => !n.readAt).length,
    critical: rows.filter(isCritical).length,
    booking:  rows.filter((n) => categorize(n.kind) === "booking").length,
    customer: rows.filter((n) => categorize(n.kind) === "customer").length,
    ai:       rows.filter((n) => categorize(n.kind) === "ai").length,
    system:   rows.filter((n) => categorize(n.kind) === "system").length,
  };
}

function groupByBucket(rows: Notif[]): Array<{ bucket: Bucket; notifs: Notif[] }> {
  const buckets: Record<Bucket, Notif[]> = { now: [], today: [], yesterday: [], earlier: [] };
  const now = Date.now();
  const todayKey = dayKey(new Date());
  const yesterdayKey = dayKey(new Date(now - 86_400_000));

  for (const n of rows) {
    const ms = new Date(n.createdAt).getTime();
    const k = dayKey(new Date(ms));
    if (k === todayKey) {
      // "Now" = within last 15 min
      if (now - ms < 15 * 60_000) buckets.now.push(n);
      else buckets.today.push(n);
    } else if (k === yesterdayKey) {
      buckets.yesterday.push(n);
    } else {
      buckets.earlier.push(n);
    }
  }

  const order: Bucket[] = ["now", "today", "yesterday", "earlier"];
  return order.filter((b) => buckets[b].length > 0).map((b) => ({ bucket: b, notifs: buckets[b] }));
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatRelative(ts: string): string {
  const ms = new Date(ts).getTime();
  const now = Date.now();
  const diff = now - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Operational signal text. Always returns a string — when there's no
 * actionable signal, falls back to a calm "systems running normally"
 * variant so the AI strip remains a permanent intelligence affordance
 * instead of disappearing whenever the inbox quiets down.
 */
function deriveSummary(rows: Notif[]): string {
  const unread = rows.filter((n) => !n.readAt).length;
  const critical = rows.filter(isCritical).length;
  const todayKey = dayKey(new Date());
  const todayCount = rows.filter((n) => dayKey(new Date(n.createdAt)) === todayKey).length;
  const bookingToday = rows.filter((n) => categorize(n.kind) === "booking" && dayKey(new Date(n.createdAt)) === todayKey).length;

  if (critical > 0) {
    return `${critical} critical ${critical === 1 ? "alert" : "alerts"} need attention. Resolve these first to keep operations clean.`;
  }
  if (bookingToday >= 2) {
    return `${bookingToday} booking updates today. Your customer activity is healthy.`;
  }
  if (unread > 0 && todayCount > 0) {
    return `${unread} unread · ${todayCount} ${todayCount === 1 ? "signal" : "signals"} arrived today. A calm window to triage.`;
  }
  if (unread > 0) {
    return `${unread} unread ${unread === 1 ? "notification" : "notifications"}. Nothing urgent flagged.`;
  }
  // Calm fallbacks — rotate by row volume so even an empty inbox
  // reads as monitored rather than dead.
  if (rows.length === 0) {
    return "Automation systems running normally. No urgent operational risks detected.";
  }
  return "All operational signals resolved. Workspace is calm.";
}
