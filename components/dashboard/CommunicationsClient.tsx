"use client";

/**
 * CommunicationsClient — Operational Communication Intelligence Center.
 *
 * Presents the existing `communication_logs` rows as customer-grouped
 * conversation threads. This is a read-only operational view; we are
 * NOT building inbound messaging here. The data shape comes from the
 * server page directly — no fetch, no API endpoint, no mutation.
 *
 * Layout:
 *   Hero
 *   AI Intelligence Strip
 *   KPI cluster (Sent / Failed / Skipped / 24h)
 *   FilterBar
 *   Split-pane:
 *     LEFT  — Conversation stream (customer-grouped threads)
 *     RIGHT — Active thread chronology + customer context
 *
 * Easing: cubic-bezier(0.16, 1, 0.3, 1) end-to-end.
 */
import * as React from "react";
import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";
import { motion } from "framer-motion";
import {
  MessageSquare,
  Mail,
  Phone,
  Smartphone,
  Bell,
  Calendar,
  Sparkles,
  Crown,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
  Inbox,
  Send,
  Filter as FilterIcon,
  Search,
  ArrowRight,
  Activity,
  type LucideIcon,
} from "lucide-react";

import { Avatar } from "@/components/ui/primitives";
import { PremiumCard, MetricCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";

// ─── Types ──────────────────────────────────────────────────────────

type CommLog = {
  id: string;
  channel: string;
  eventType: string;
  status: string;
  provider: string | null;
  failureReason: string | null;
  skippedReason: string | null;
  sentAt: string | null;
  createdAt: string;
  customerId: string | null;
  bookingId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerStatus: string | null;
  bookingStartAt: string | null;
};

type Filter = "all" | "sent" | "failed" | "skipped" | "recent" | "vip";

const FILTERS: Filter[] = ["all", "sent", "failed", "skipped", "recent", "vip"];

const FILTER_LABEL: Record<Filter, string> = {
  all:     "All",
  sent:    "Sent",
  failed:  "Failed",
  skipped: "Skipped",
  recent:  "Recent · 24h",
  vip:     "VIP",
};

// ─── Channel + event metadata ──────────────────────────────────────

const CHANNEL_META: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  email: { label: "Email", icon: Mail,       tone: "bg-brand-subtle text-brand-accent" },
  sms:   { label: "SMS",   icon: Smartphone, tone: "bg-emerald-50 text-emerald-700" },
  push:  { label: "Push",  icon: Bell,       tone: "bg-amber-50 text-amber-700" },
  voice: { label: "Voice", icon: Phone,      tone: "bg-violet-50 text-violet-700" },
};
function channelMeta(channel: string) {
  return CHANNEL_META[channel.toLowerCase()] ?? CHANNEL_META.email;
}

function formatEventType(eventType: string): string {
  return eventType
    .replace(/[._]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Thread aggregation ────────────────────────────────────────────

type Thread = {
  /** Stable per-customer key when a customer is attached; otherwise
   *  per-bookingId; otherwise per-row id. */
  key: string;
  customerId: string | null;
  bookingId: string | null;
  customerName: string;
  customerEmail: string | null;
  customerStatus: string | null;
  /** Most recent touchpoint in the thread. */
  latest: CommLog;
  /** All touchpoints for this thread, newest first. */
  logs: CommLog[];
  /** True when any touchpoint failed in the last 24h. */
  hasRecentFailure: boolean;
};

function buildThreads(rows: CommLog[]): Thread[] {
  const byKey = new Map<string, Thread>();
  const dayAgo = Date.now() - 86_400_000;

  for (const r of rows) {
    const key = r.customerId ?? r.bookingId ?? `solo-${r.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        customerId: r.customerId,
        bookingId: r.bookingId,
        customerName: r.customerName ?? r.customerEmail ?? "Unknown recipient",
        customerEmail: r.customerEmail,
        customerStatus: r.customerStatus,
        latest: r,
        logs: [r],
        hasRecentFailure:
          r.status === "failed" && new Date(r.createdAt).getTime() >= dayAgo,
      });
    } else {
      existing.logs.push(r);
      if (new Date(r.createdAt).getTime() > new Date(existing.latest.createdAt).getTime()) {
        existing.latest = r;
      }
      if (r.status === "failed" && new Date(r.createdAt).getTime() >= dayAgo) {
        existing.hasRecentFailure = true;
      }
    }
  }
  // Sort threads by latest touchpoint descending.
  return Array.from(byKey.values()).sort(
    (a, b) => new Date(b.latest.createdAt).getTime() - new Date(a.latest.createdAt).getTime(),
  );
}

// ─── Stats + intelligence ──────────────────────────────────────────

function computeStats(rows: CommLog[]) {
  const dayAgo = Date.now() - 86_400_000;
  const thirty = Date.now() - 30 * 86_400_000;
  return {
    sent30: rows.filter((r) => r.status === "sent" && new Date(r.createdAt).getTime() >= thirty).length,
    failed30: rows.filter((r) => r.status === "failed" && new Date(r.createdAt).getTime() >= thirty).length,
    skipped30: rows.filter((r) => r.status === "skipped" && new Date(r.createdAt).getTime() >= thirty).length,
    last24: rows.filter((r) => new Date(r.createdAt).getTime() >= dayAgo).length,
  };
}

function deriveSignal(rows: CommLog[]): string {
  if (rows.length === 0) {
    return "Communication channels are ready. Outbound activity will surface here once your automations fire.";
  }
  const dayAgo = Date.now() - 86_400_000;
  const failed24 = rows.filter(
    (r) => r.status === "failed" && new Date(r.createdAt).getTime() >= dayAgo,
  ).length;
  const sent24 = rows.filter(
    (r) => r.status === "sent" && new Date(r.createdAt).getTime() >= dayAgo,
  ).length;
  if (failed24 > 0) {
    return `${failed24} ${failed24 === 1 ? "delivery failed" : "deliveries failed"} in the last 24 hours. Review the failed thread${failed24 === 1 ? "" : "s"} below.`;
  }
  if (sent24 >= 10) {
    return `${sent24} touchpoints delivered in the last 24 hours. Communication systems running clean.`;
  }
  if (sent24 > 0) {
    return `${sent24} ${sent24 === 1 ? "message" : "messages"} sent in the last 24 hours. Response infrastructure is healthy.`;
  }
  return "No urgent communication risks detected. Operational delivery is steady.";
}

// ─── Filters ────────────────────────────────────────────────────────

function applyFilter(rows: CommLog[], filter: Filter): CommLog[] {
  switch (filter) {
    case "all":     return rows;
    case "sent":    return rows.filter((r) => r.status === "sent");
    case "failed":  return rows.filter((r) => r.status === "failed");
    case "skipped": return rows.filter((r) => r.status === "skipped");
    case "recent": {
      const cutoff = Date.now() - 86_400_000;
      return rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
    }
    case "vip":     return rows.filter((r) => r.customerStatus === "vip");
  }
}

function computeCounts(rows: CommLog[]): Record<Filter, number> {
  const cutoff = Date.now() - 86_400_000;
  return {
    all:     rows.length,
    sent:    rows.filter((r) => r.status === "sent").length,
    failed:  rows.filter((r) => r.status === "failed").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    recent:  rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff).length,
    vip:     rows.filter((r) => r.customerStatus === "vip").length,
  };
}

// ─── Main component ────────────────────────────────────────────────

export default function CommunicationsClient({
  initial,
  userTimezone,
}: {
  initial: CommLog[];
  userTimezone: string;
}) {
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [activeKey, setActiveKey] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    let f = applyFilter(initial, filter);
    const q = search.trim().toLowerCase();
    if (q) {
      f = f.filter(
        (r) =>
          (r.customerName ?? "").toLowerCase().includes(q) ||
          (r.customerEmail ?? "").toLowerCase().includes(q) ||
          r.eventType.toLowerCase().includes(q),
      );
    }
    return f;
  }, [initial, filter, search]);

  const threads = React.useMemo(() => buildThreads(filtered), [filtered]);
  const counts = React.useMemo(() => computeCounts(initial), [initial]);
  const stats = React.useMemo(() => computeStats(initial), [initial]);
  const signal = React.useMemo(() => deriveSignal(initial), [initial]);

  // Default-select the first thread once data loads.
  React.useEffect(() => {
    if (!activeKey && threads.length > 0) setActiveKey(threads[0].key);
    if (activeKey && !threads.find((t) => t.key === activeKey) && threads.length > 0) {
      setActiveKey(threads[0].key);
    }
  }, [threads, activeKey]);

  const activeThread = threads.find((t) => t.key === activeKey) ?? null;

  return (
    <div className="relative mt-6 space-y-5">
      {/* Ambient background depth */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-32 -z-10 h-80 w-80 rounded-full bg-brand-accent/[0.05] blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 top-96 -z-10 h-72 w-72 rounded-full bg-brand-accent/[0.04] blur-3xl"
      />

      {/* Hero */}
      <FadeIn>
        <Hero stats={stats} />
      </FadeIn>

      {/* AI intelligence strip */}
      <FadeIn delay={1}>
        <AIStrip signal={signal} />
      </FadeIn>

      {/* KPI cluster */}
      <FadeIn delay={2}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Sent · 30d"    value={String(stats.sent30)}    icon={Send}        tone="brand" />
          <MetricCard label="Failed · 30d"  value={String(stats.failed30)}  icon={AlertTriangle} tone={stats.failed30 > 0 ? "warning" : "neutral"} />
          <MetricCard label="Skipped · 30d" value={String(stats.skipped30)} icon={Clock}       tone="neutral" />
          <MetricCard label="Last 24h"      value={String(stats.last24)}    icon={Activity}    tone="positive" />
        </div>
      </FadeIn>

      {/* Search + filters */}
      <FadeIn delay={3}>
        <SearchAndFilters
          search={search}
          onSearch={setSearch}
          filter={filter}
          onFilter={setFilter}
          counts={counts}
        />
      </FadeIn>

      {/* Body — split pane */}
      {threads.length === 0 ? (
        <FadeIn delay={4}>
          <EmptyState
            hasAnyData={initial.length > 0}
            search={search}
            filter={filter}
          />
        </FadeIn>
      ) : (
        <FadeIn delay={4}>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <ThreadStream
              threads={threads}
              activeKey={activeKey}
              onSelect={setActiveKey}
              userTimezone={userTimezone}
            />
            <ActiveThread thread={activeThread} userTimezone={userTimezone} />
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────

function Hero({ stats }: { stats: ReturnType<typeof computeStats> }) {
  const total24 = stats.last24;
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/40 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-accent/12 blur-3xl"
      />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
            <MessageSquare className="h-3 w-3" strokeWidth={2} />
            Operational communication intelligence
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Communications
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Every outbound touchpoint across your workspace — automations, reminders, confirmations, and follow-ups.
          </p>
        </div>
        {total24 > 0 && (
          <span className="zm-pulse-glow inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
            <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
            {total24} in 24h
          </span>
        )}
      </div>
    </PremiumCard>
  );
}

// ─── AI strip ──────────────────────────────────────────────────────

function AIStrip({ signal }: { signal: string }) {
  return (
    <div className="zm-border-sweep relative overflow-hidden rounded-2xl">
      <div className="relative overflow-hidden rounded-2xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/45 via-surface to-surface shadow-soft">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/12 blur-3xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
        <span
          aria-hidden
          className="zm-light-sweep pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent"
        />

        <div className="relative flex items-center gap-3 px-4 py-3 sm:px-5">
          <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(53,157,243,0.35)]">
            <Sparkles className="h-4 w-4" strokeWidth={2} />
            <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2.5 w-2.5 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/55" />
              <span className="relative h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)] ring-2 ring-surface" />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Communication signal
            </div>
            <div className="mt-0.5 text-[13px] leading-relaxed text-ink">{signal}</div>
          </div>
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

// ─── Search + filters ─────────────────────────────────────────────

function SearchAndFilters({
  search, onSearch, filter, onFilter, counts,
}: {
  search: string;
  onSearch: (s: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  counts: Record<Filter, number>;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-surface px-2.5 py-2 shadow-soft">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-md flex-1">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-ink-subtle" strokeWidth={1.75} aria-hidden />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by customer name, email, or event…"
            className="w-full rounded-xl border border-border bg-surface-subtle py-1.5 pl-9 pr-3 text-[13px] outline-none transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-border-strong focus:border-brand-accent focus:bg-surface focus:ring-4 focus:ring-brand-accent/15"
          />
        </div>
        <div className="relative inline-flex flex-wrap items-center gap-0.5 rounded-xl border border-border bg-surface-subtle p-0.5 shadow-soft">
          {FILTERS.map((f) => {
            const active = filter === f;
            const n = counts[f];
            return (
              <button
                key={f}
                onClick={() => onFilter(f)}
                aria-pressed={active}
                className={cn(
                  "relative z-10 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.97]",
                  active ? "text-white" : "text-ink-muted hover:text-ink",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="communications-filter-indicator"
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
      </div>
    </div>
  );
}

// ─── Thread stream (left pane) ────────────────────────────────────

function ThreadStream({
  threads,
  activeKey,
  onSelect,
  userTimezone,
}: {
  threads: Thread[];
  activeKey: string | null;
  onSelect: (k: string) => void;
  userTimezone: string;
}) {
  return (
    <PremiumCard compact interactive={false} className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
          Conversations
        </span>
        <span className="text-[10px] font-medium tabular-nums text-ink-subtle">{threads.length}</span>
      </div>
      <ul className="max-h-[640px] divide-y divide-border/40 overflow-y-auto">
        {threads.map((t) => {
          const isActive = t.key === activeKey;
          const meta = channelMeta(t.latest.channel);
          const Icon = meta.icon;
          const isVip = t.customerStatus === "vip";
          const failed = t.latest.status === "failed";
          return (
            <li key={t.key}>
              <button
                type="button"
                onClick={() => onSelect(t.key)}
                className={cn(
                  "group relative block w-full overflow-hidden px-4 py-3 text-left transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                  "hover:bg-surface-inset/40",
                  isActive && "bg-gradient-to-r from-brand-subtle/40 via-surface to-surface",
                )}
              >
                {/* Active rail */}
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-brand-accent to-brand-hover shadow-[0_0_10px_rgba(53,157,243,0.45)]"
                  />
                )}
                <div className="flex items-start gap-2.5">
                  <Avatar name={t.customerName} size="sm" className="!h-9 !w-9 !text-[11px]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold tracking-tight text-ink">
                        {t.customerName}
                      </span>
                      {isVip && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700 ring-1 ring-amber-200/40">
                          <Crown className="h-2.5 w-2.5" strokeWidth={2} />
                          VIP
                        </span>
                      )}
                      {t.hasRecentFailure && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-red-50/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-red-700 ring-1 ring-red-200/40">
                          <AlertTriangle className="h-2.5 w-2.5" strokeWidth={2} />
                          Failed
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                      <Icon className={cn("h-3 w-3", meta.tone.split(" ")[1] /* text class only */)} strokeWidth={1.75} />
                      <span className="truncate">{formatEventType(t.latest.eventType)}</span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-subtle">
                      <StatusDot status={t.latest.status} />
                      <span className="capitalize">{t.latest.status}</span>
                      <span>·</span>
                      <span>{formatRelative(t.latest.createdAt)}</span>
                      <span>·</span>
                      <span>{t.logs.length} {t.logs.length === 1 ? "touch" : "touches"}</span>
                    </div>
                  </div>
                  {failed && !isActive && (
                    <ArrowRight className="mt-1 h-3.5 w-3.5 text-red-500" strokeWidth={2} />
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </PremiumCard>
  );
}

// ─── Active thread (right pane) ───────────────────────────────────

function ActiveThread({
  thread,
  userTimezone,
}: {
  thread: Thread | null;
  userTimezone: string;
}) {
  if (!thread) {
    return (
      <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/20 via-surface to-surface">
        <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
          <div className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
            <Inbox className="h-6 w-6" strokeWidth={1.75} />
          </div>
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">Select a conversation</h3>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Pick a thread on the left to see the full touchpoint timeline.
          </p>
        </div>
      </PremiumCard>
    );
  }

  const isVip = thread.customerStatus === "vip";
  return (
    <PremiumCard compact interactive={false} className="overflow-hidden p-0">
      {/* Customer hero */}
      <div className="relative overflow-hidden border-b border-border/70 bg-gradient-to-br from-brand-subtle/45 via-surface to-surface px-5 py-4">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-brand-accent/10 blur-3xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/60 to-transparent"
        />
        <div className="relative flex items-start gap-3">
          <Avatar name={thread.customerName} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[16px] font-semibold tracking-tight text-ink">
                {thread.customerName}
              </h2>
              {isVip && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-700 ring-1 ring-amber-200/40">
                  <Crown className="h-2.5 w-2.5" strokeWidth={2} />
                  VIP
                </span>
              )}
            </div>
            {thread.customerEmail && (
              <a
                href={`mailto:${thread.customerEmail}`}
                className="mt-0.5 inline-flex items-center gap-1 text-[12px] text-brand-accent transition-colors hover:text-brand-hover"
              >
                <Mail className="h-3 w-3" strokeWidth={1.75} />
                {thread.customerEmail}
              </a>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-subtle">
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 font-medium uppercase tracking-wider">
                {thread.logs.length} {thread.logs.length === 1 ? "touchpoint" : "touchpoints"}
              </span>
              {thread.customerId && (
                <Link
                  href={`/dashboard/customers?focus=${thread.customerId}`}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-muted shadow-soft transition-colors hover:bg-surface-inset hover:text-ink"
                >
                  Customer profile
                  <ArrowRight className="h-2.5 w-2.5" strokeWidth={2.25} />
                </Link>
              )}
              {thread.bookingId && (
                <Link
                  href="/dashboard/appointments"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-0.5 text-[10px] font-semibold text-ink-muted shadow-soft transition-colors hover:bg-surface-inset hover:text-ink"
                >
                  <Calendar className="h-2.5 w-2.5" strokeWidth={1.75} />
                  Linked booking
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Touchpoint timeline */}
      <ul className="max-h-[640px] divide-y divide-border/40 overflow-y-auto px-2 py-1">
        {thread.logs.map((log) => (
          <li key={log.id}>
            <TouchpointRow log={log} userTimezone={userTimezone} />
          </li>
        ))}
      </ul>
    </PremiumCard>
  );
}

function TouchpointRow({ log, userTimezone }: { log: CommLog; userTimezone: string }) {
  const meta = channelMeta(log.channel);
  const Icon = meta.icon;
  return (
    <div className="flex items-start gap-3 px-2.5 py-3">
      <div className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ring-1 ring-border/40", meta.tone)}>
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold tracking-tight text-ink">
              {formatEventType(log.eventType)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-ink-subtle">
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 font-medium uppercase tracking-wider">
                {meta.label}
              </span>
              {log.provider && (
                <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset/70 px-1.5 py-0.5 font-medium">
                  {log.provider}
                </span>
              )}
              <span>·</span>
              <span>
                {log.sentAt
                  ? formatInTimeZone(log.sentAt, userTimezone, "MMM d · h:mm a")
                  : formatInTimeZone(log.createdAt, userTimezone, "MMM d · h:mm a")}
              </span>
            </div>
            {log.failureReason && (
              <div className="mt-1 text-[11px] text-red-600">
                <AlertTriangle className="mr-0.5 inline h-3 w-3" strokeWidth={2} />
                {log.failureReason}
              </div>
            )}
            {log.skippedReason && !log.failureReason && (
              <div className="mt-1 text-[11px] text-amber-700">
                <Clock className="mr-0.5 inline h-3 w-3" strokeWidth={2} />
                Skipped · {log.skippedReason}
              </div>
            )}
          </div>
          <StatusPill status={log.status} />
        </div>
      </div>
    </div>
  );
}

// ─── Status visuals ───────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const dot =
    status === "sent" ? "bg-emerald-500"
    : status === "failed" ? "bg-red-500"
    : status === "skipped" ? "bg-amber-500"
    : "bg-slate-400";
  return <span aria-hidden className={cn("inline-block h-1.5 w-1.5 rounded-full", dot)} />;
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; icon: LucideIcon }> = {
    sent:    { label: "Sent",    cls: "bg-emerald-50/80 text-emerald-700 ring-1 ring-emerald-200/40", icon: CheckCircle2 },
    failed:  { label: "Failed",  cls: "bg-red-50/80 text-red-700 ring-1 ring-red-200/40",             icon: XCircle      },
    skipped: { label: "Skipped", cls: "bg-amber-50/80 text-amber-700 ring-1 ring-amber-200/40",      icon: Clock        },
  };
  const m = map[status] ?? { label: status, cls: "bg-surface-inset text-ink-muted", icon: Activity };
  const Icon = m.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider", m.cls)}>
      <Icon className="h-2.5 w-2.5" strokeWidth={2} />
      {m.label}
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────

function EmptyState({
  hasAnyData,
  search,
  filter,
}: {
  hasAnyData: boolean;
  search: string;
  filter: Filter;
}) {
  if (hasAnyData) {
    let title = "Nothing matches the current filter";
    let body = "Try a different filter or clear your search.";
    if (search) {
      title = `No results for "${search}"`;
      body = "Try a different name, email, or event keyword.";
    } else if (filter === "failed") {
      title = "No failed deliveries";
      body = "Your outbound communication infrastructure is clean.";
    } else if (filter === "vip") {
      title = "No VIP communications";
      body = "VIP customer touchpoints will surface here.";
    } else if (filter === "recent") {
      title = "Nothing in the last 24h";
      body = "Recent activity will appear here as automations fire.";
    }
    return (
      <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/20 via-surface to-surface">
        <div className="flex items-start gap-3 px-2 py-4">
          <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
            <FilterIcon className="h-5 w-5" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">{title}</h3>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{body}</p>
          </div>
        </div>
      </PremiumCard>
    );
  }
  return (
    <PremiumCard interactive={false} className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/35 via-surface to-brand-subtle/20">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/40 to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-brand-accent/12 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 bottom-0 h-56 w-56 rounded-full bg-brand-accent/8 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute right-12 top-8 h-24 w-24 rounded-full bg-brand-accent/10 blur-2xl zm-drift-slow"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-16 bottom-12 h-20 w-20 rounded-full bg-emerald-400/8 blur-2xl zm-drift-slow-reverse"
      />
      <div className="relative flex flex-col items-center justify-center px-4 py-12 text-center">
        <div className="relative mb-5 inline-flex h-24 w-24 items-center justify-center">
          <span aria-hidden className="zm-ring-pulse-3 absolute h-24 w-24 rounded-full border border-brand-accent/8 blur-[1px]" />
          <span aria-hidden className="zm-ring-pulse-2 absolute h-[76px] w-[76px] rounded-full border border-brand-accent/18" />
          <span aria-hidden className="zm-ring-pulse-1 absolute h-[60px] w-[60px] rounded-full border-2 border-brand-accent/30" />
          <span aria-hidden className="absolute h-16 w-16 rounded-full bg-brand-accent/15 blur-2xl" />
          <div className="zm-pulse-glow relative inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
            <MessageSquare className="h-5 w-5" strokeWidth={1.75} />
          </div>
        </div>

        <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
          Ready
        </div>
        <h3 className="mt-1 text-[18px] font-semibold tracking-tight text-ink">
          Your communication workspace is ready
        </h3>
        <p className="mt-1 max-w-[420px] text-[12px] leading-relaxed text-ink-muted">
          Outbound touchpoints — booking confirmations, reminders, follow-ups — will appear here as your automations fire.
        </p>
        <div className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/70 px-3 py-1 text-[10px] font-medium text-ink-muted backdrop-blur-sm">
          <span aria-hidden className="relative inline-flex h-2 w-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/50" />
            <span className="relative h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Channels monitored · Email, SMS, Push, Voice
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Link
            href="/dashboard/settings/communications"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
          >
            Configure channels
            <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
          </Link>
          <Link
            href="/dashboard/settings/communications/templates"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            Manage templates
          </Link>
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

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
