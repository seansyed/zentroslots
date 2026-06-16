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
  Pin,
  PinOff,
  ListChecks,
  CalendarPlus,
  BellRing,
  Heart,
  Flame,
  type LucideIcon,
} from "lucide-react";

import { Avatar, toast } from "@/components/ui/primitives";
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

type Filter = "all" | "sent" | "failed" | "awaiting" | "bookings" | "recent" | "vip";

const FILTERS: Filter[] = ["all", "sent", "failed", "awaiting", "bookings", "recent", "vip"];

const FILTER_LABEL: Record<Filter, string> = {
  all:      "All",
  sent:     "Sent",
  failed:   "Failed",
  awaiting: "Awaiting reply",
  bookings: "Bookings",
  recent:   "Recent · 24h",
  vip:      "VIP",
};

const AWAITING_DAYS = 7;

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
  const sent30 = rows.filter((r) => r.status === "sent" && new Date(r.createdAt).getTime() >= thirty).length;
  const failed30 = rows.filter((r) => r.status === "failed" && new Date(r.createdAt).getTime() >= thirty).length;
  const skipped30 = rows.filter((r) => r.status === "skipped" && new Date(r.createdAt).getTime() >= thirty).length;
  const last24 = rows.filter((r) => new Date(r.createdAt).getTime() >= dayAgo).length;
  // Response rate — proportion of recorded deliveries that successfully
  // sent (vs. failed/skipped). 30-day window.
  const totalAttempts = sent30 + failed30 + skipped30;
  const responseRatePct = totalAttempts > 0 ? Math.round((sent30 / totalAttempts) * 100) : 0;
  // Awaiting reply — distinct customers whose last outbound touchpoint
  // was >= AWAITING_DAYS ago. Implies the relationship is "open" with
  // no follow-up scheduled.
  const lastByCustomer = new Map<string, number>();
  for (const r of rows) {
    if (!r.customerId) continue;
    const ms = new Date(r.createdAt).getTime();
    const prev = lastByCustomer.get(r.customerId) ?? 0;
    if (ms > prev) lastByCustomer.set(r.customerId, ms);
  }
  const awaitingCutoff = Date.now() - AWAITING_DAYS * 86_400_000;
  const awaitingReply = Array.from(lastByCustomer.values()).filter((ms) => ms < awaitingCutoff).length;
  return { sent30, failed30, skipped30, last24, responseRatePct, awaitingReply };
}

function deriveSignal(rows: CommLog[], stats: ReturnType<typeof computeStats>): string {
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
  if (stats.awaitingReply >= 3) {
    return `${stats.awaitingReply} customers haven't been contacted in over ${AWAITING_DAYS} days. A good window for proactive follow-up.`;
  }
  if (sent24 >= 10) {
    return `${sent24} touchpoints delivered in the last 24 hours. Communication systems running clean.`;
  }
  if (stats.responseRatePct >= 95 && stats.sent30 + stats.failed30 + stats.skipped30 >= 10) {
    return `Response rate is ${stats.responseRatePct}% over the last 30 days. Delivery infrastructure is healthy.`;
  }
  if (sent24 > 0) {
    return `${sent24} ${sent24 === 1 ? "message" : "messages"} sent in the last 24 hours. Response infrastructure is healthy.`;
  }
  return "No urgent communication risks detected. Operational delivery is steady.";
}

// ─── Priority + relationship signals ──────────────────────────────

type ThreadPriority = "urgent" | "warning" | "opportunity" | "standard";

function deriveThreadPriority(t: Thread): ThreadPriority {
  const now = Date.now();
  if (t.hasRecentFailure) return "urgent";
  const latestMs = new Date(t.latest.createdAt).getTime();
  const ageDays = (now - latestMs) / 86_400_000;
  const isVip = t.customerStatus === "vip";
  if (isVip && ageDays >= AWAITING_DAYS) return "warning";
  if (
    t.bookingId &&
    t.latest.bookingStartAt &&
    new Date(t.latest.bookingStartAt).getTime() > now
  ) {
    return "opportunity";
  }
  if (ageDays >= 14) return "warning";
  return "standard";
}

const PRIORITY_RAIL: Record<ThreadPriority, string> = {
  urgent:      "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.45)]",
  warning:     "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.35)]",
  opportunity: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.35)]",
  standard:    "bg-brand-accent/20",
};

const PRIORITY_BG: Record<ThreadPriority, string> = {
  urgent:      "bg-gradient-to-r from-red-50/35 via-surface to-surface",
  warning:     "bg-gradient-to-r from-amber-50/30 via-surface to-surface",
  opportunity: "bg-gradient-to-r from-emerald-50/30 via-surface to-surface",
  standard:    "",
};

type Warmth = {
  /** Lifetime touchpoint count for this customer. */
  touches: number;
  /** Days since first known touchpoint. 0 when only one touchpoint exists. */
  longevityDays: number;
  /** True when the customer has touchpoints across 3+ unique days. */
  highlyEngaged: boolean;
};

function deriveWarmth(t: Thread): Warmth {
  const touches = t.logs.length;
  const ms = t.logs.map((l) => new Date(l.createdAt).getTime());
  const earliest = Math.min(...ms);
  const longevityDays = Math.floor((Date.now() - earliest) / 86_400_000);
  const uniqueDays = new Set(
    t.logs.map((l) => new Date(l.createdAt).toISOString().slice(0, 10)),
  ).size;
  return { touches, longevityDays, highlyEngaged: uniqueDays >= 3 };
}

type Engagement = "strong" | "steady" | "cooling";

function deriveEngagement(t: Thread): Engagement {
  const now = Date.now();
  const latestMs = new Date(t.latest.createdAt).getTime();
  const ageDays = (now - latestMs) / 86_400_000;
  const w = deriveWarmth(t);
  if (ageDays <= 3 && w.highlyEngaged) return "strong";
  if (ageDays <= 7) return "steady";
  return "cooling";
}

type Confidence = "high" | "medium" | "low";

function deriveConfidence(t: Thread): Confidence {
  // Confidence = how strongly we believe the suggestion fits. Driven
  // by touch volume and recency. >= 5 recent touches → high; some
  // history → medium; almost no signal → low.
  const recent = t.logs.filter(
    (l) => Date.now() - new Date(l.createdAt).getTime() < 30 * 86_400_000,
  ).length;
  if (recent >= 5) return "high";
  if (recent >= 2) return "medium";
  return "low";
}

// ─── Filters ────────────────────────────────────────────────────────

/**
 * Identify customers whose most-recent touchpoint is older than the
 * awaiting-reply cutoff. Returns the set of their customerIds. */
function awaitingCustomerIds(rows: CommLog[]): Set<string> {
  const lastByCustomer = new Map<string, number>();
  for (const r of rows) {
    if (!r.customerId) continue;
    const ms = new Date(r.createdAt).getTime();
    const prev = lastByCustomer.get(r.customerId) ?? 0;
    if (ms > prev) lastByCustomer.set(r.customerId, ms);
  }
  const cutoff = Date.now() - AWAITING_DAYS * 86_400_000;
  const set = new Set<string>();
  for (const [cid, ms] of lastByCustomer) {
    if (ms < cutoff) set.add(cid);
  }
  return set;
}

function applyFilter(rows: CommLog[], filter: Filter): CommLog[] {
  switch (filter) {
    case "all":      return rows;
    case "sent":     return rows.filter((r) => r.status === "sent");
    case "failed":   return rows.filter((r) => r.status === "failed");
    case "bookings": return rows.filter((r) => !!r.bookingId);
    case "vip":      return rows.filter((r) => r.customerStatus === "vip");
    case "recent": {
      const cutoff = Date.now() - 86_400_000;
      return rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
    }
    case "awaiting": {
      const ids = awaitingCustomerIds(rows);
      return rows.filter((r) => r.customerId && ids.has(r.customerId));
    }
  }
}

function computeCounts(rows: CommLog[]): Record<Filter, number> {
  const cutoff = Date.now() - 86_400_000;
  // Customer-level awaiting count (not row-level) — reads correctly
  // as "5 customers awaiting" rather than "23 touchpoints awaiting".
  const awaitingCount = awaitingCustomerIds(rows).size;
  return {
    all:      rows.length,
    sent:     rows.filter((r) => r.status === "sent").length,
    failed:   rows.filter((r) => r.status === "failed").length,
    awaiting: awaitingCount,
    bookings: rows.filter((r) => !!r.bookingId).length,
    recent:   rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff).length,
    vip:      rows.filter((r) => r.customerStatus === "vip").length,
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
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  // Pinned threads — visual-only persistence in localStorage. Pinned
  // threads sort to the top of the stream. No backend involvement.
  const [pinnedKeys, setPinnedKeys] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("comm_pinned_threads");
      if (raw) setPinnedKeys(new Set(JSON.parse(raw) as string[]));
    } catch { /* swallow */ }
  }, []);
  function togglePin(key: string) {
    setPinnedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try {
        window.localStorage.setItem("comm_pinned_threads", JSON.stringify(Array.from(next)));
      } catch { /* swallow */ }
      return next;
    });
    toast(pinnedKeys.has(key) ? "Unpinned" : "Pinned to top", "success");
  }

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

  const threads = React.useMemo(() => {
    const built = buildThreads(filtered);
    // Pin sort: pinned threads first, then natural order.
    return built.sort((a, b) => {
      const ap = pinnedKeys.has(a.key) ? 1 : 0;
      const bp = pinnedKeys.has(b.key) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return new Date(b.latest.createdAt).getTime() - new Date(a.latest.createdAt).getTime();
    });
  }, [filtered, pinnedKeys]);
  const counts = React.useMemo(() => computeCounts(initial), [initial]);
  const stats = React.useMemo(() => computeStats(initial), [initial]);
  const signal = React.useMemo(() => deriveSignal(initial, stats), [initial, stats]);

  // Default-select the first thread once data loads.
  React.useEffect(() => {
    if (!activeKey && threads.length > 0) setActiveKey(threads[0].key);
    if (activeKey && !threads.find((t) => t.key === activeKey) && threads.length > 0) {
      setActiveKey(threads[0].key);
    }
  }, [threads, activeKey]);

  // Keyboard navigation — Arrow keys / J / K to move between threads,
  // Shift+J/K to jump 5, "/" to focus search. Superhuman / Linear
  // pattern. Ignored while the user is typing in form fields.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tgt = e.target as HTMLElement | null;
      const inField = !!(tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable));
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      const lower = key.toLowerCase();

      // "/" — focus search (works even from outside an input).
      if (!inField && key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // Esc inside the search field clears + blurs.
      if (inField && key === "Escape" && tgt === searchRef.current) {
        e.preventDefault();
        setSearch("");
        (tgt as HTMLInputElement).blur();
        return;
      }
      if (inField) return;
      if (threads.length === 0) return;
      const isNext = lower === "arrowdown" || lower === "j";
      const isPrev = lower === "arrowup" || lower === "k";
      if (!isNext && !isPrev) return;
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      const idx = Math.max(0, threads.findIndex((t) => t.key === activeKey));
      const next = isNext
        ? Math.min(threads.length - 1, idx + step)
        : Math.max(0, idx - step);
      setActiveKey(threads[next].key);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
          <MetricCard label="Sent · 30d"      value={String(stats.sent30)}        icon={Send}          tone="brand" />
          <MetricCard label="Failed · 30d"    value={String(stats.failed30)}      icon={AlertTriangle} tone={stats.failed30 > 0 ? "warning" : "neutral"} />
          <MetricCard label="Response rate"   value={`${stats.responseRatePct}%`} icon={CheckCircle2}  tone="positive" />
          <MetricCard label="Awaiting reply"  value={String(stats.awaitingReply)} icon={Clock}         tone={stats.awaitingReply > 0 ? "warning" : "neutral"} />
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
          searchRef={searchRef}
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
              pinnedKeys={pinnedKeys}
            />
            <ActiveThread
              thread={activeThread}
              userTimezone={userTimezone}
              isPinned={activeThread ? pinnedKeys.has(activeThread.key) : false}
              onTogglePin={() => activeThread && togglePin(activeThread.key)}
            />
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
          <span className="zm-pulse-glow inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-brand-accent to-brand-hover px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-white shadow-[0_4px_12px_rgba(37,99,235,0.35)]">
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
          <div className="zm-pulse-glow relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_12px_rgba(37,99,235,0.35)]">
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
  search, onSearch, filter, onFilter, counts, searchRef,
}: {
  search: string;
  onSearch: (s: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  counts: Record<Filter, number>;
  searchRef?: React.RefObject<HTMLInputElement | null>;
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
            ref={searchRef}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search… (press / to focus)"
            className="w-full rounded-xl border border-border bg-surface-subtle py-1.5 pl-9 pr-10 text-[13px] outline-none transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-border-strong focus:border-brand-accent focus:bg-surface focus:ring-4 focus:ring-brand-accent/15"
          />
          <kbd className="absolute right-2.5 top-1.5 hidden h-5 min-w-[18px] items-center justify-center rounded border border-border bg-surface px-1 font-mono text-[10px] font-semibold text-ink-subtle sm:inline-flex">/</kbd>
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
                    className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover shadow-[0_4px_12px_rgba(37,99,235,0.35),inset_0_1px_0_rgba(255,255,255,0.25)]"
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
  pinnedKeys,
}: {
  threads: Thread[];
  activeKey: string | null;
  onSelect: (k: string) => void;
  userTimezone: string;
  pinnedKeys: Set<string>;
}) {
  return (
    <PremiumCard compact interactive={false} className="overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
          Conversations
        </span>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1 text-[10px] text-ink-subtle sm:inline-flex">
            <kbd className="inline-flex h-4 min-w-[14px] items-center justify-center rounded border border-border bg-surface px-1 font-mono text-[9px] font-semibold text-ink-muted">↑</kbd>
            <kbd className="inline-flex h-4 min-w-[14px] items-center justify-center rounded border border-border bg-surface px-1 font-mono text-[9px] font-semibold text-ink-muted">↓</kbd>
            navigate
          </span>
          <span className="text-[10px] font-medium tabular-nums text-ink-subtle">{threads.length}</span>
        </div>
      </div>
      <ul className="max-h-[640px] divide-y divide-border/40 overflow-y-auto">
        {threads.map((t) => {
          const isActive = t.key === activeKey;
          const meta = channelMeta(t.latest.channel);
          const Icon = meta.icon;
          const isVip = t.customerStatus === "vip";
          const priority = deriveThreadPriority(t);
          const isPinned = pinnedKeys.has(t.key);
          return (
            <li key={t.key}>
              <button
                type="button"
                onClick={() => onSelect(t.key)}
                className={cn(
                  "group relative block w-full overflow-hidden px-4 py-3 text-left transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
                  "hover:bg-surface-inset/40",
                  // Priority bg tint when not actively selected — gives
                  // the eye an instant scan-priority signal.
                  !isActive && PRIORITY_BG[priority],
                  isActive && "bg-gradient-to-r from-brand-subtle/40 via-surface to-surface",
                )}
              >
                {/* Left rail — active state always wins; otherwise the
                    rail color reflects the thread's priority. */}
                {isActive ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-0.5 bg-gradient-to-b from-brand-accent to-brand-hover shadow-[0_0_10px_rgba(37,99,235,0.45)]"
                  />
                ) : (
                  priority !== "standard" && (
                    <span
                      aria-hidden
                      className={cn("absolute inset-y-0 left-0 w-0.5", PRIORITY_RAIL[priority])}
                    />
                  )
                )}
                <div className="flex items-start gap-2.5">
                  <Avatar name={t.customerName} size="sm" className="!h-9 !w-9 !text-[11px]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold tracking-tight text-ink">
                        {t.customerName}
                      </span>
                      {isPinned && (
                        <Pin className="h-2.5 w-2.5 shrink-0 text-brand-accent" strokeWidth={2.5} aria-label="Pinned" />
                      )}
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
                      {priority === "opportunity" && !t.hasRecentFailure && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-700 ring-1 ring-emerald-200/40">
                          <Calendar className="h-2.5 w-2.5" strokeWidth={2} />
                          Upcoming
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted">
                      <Icon className={cn("h-3 w-3", meta.tone.split(" ")[1])} strokeWidth={1.75} />
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
                  {t.hasRecentFailure && !isActive && (
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
  isPinned,
  onTogglePin,
}: {
  thread: Thread | null;
  userTimezone: string;
  isPinned: boolean;
  onTogglePin: () => void;
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
              {/* Relationship warmth chips — calm trust-building copy */}
              <WarmthChips thread={thread} />
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

            {/* Quick action ghost row */}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <QuickAction
                icon={isPinned ? PinOff : Pin}
                label={isPinned ? "Unpin" : "Pin"}
                onClick={onTogglePin}
                tone={isPinned ? "brand" : "neutral"}
              />
              <QuickAction
                icon={ListChecks}
                label="Create task"
                href="/dashboard/tasks"
              />
              <QuickAction
                icon={CalendarPlus}
                label="Schedule follow-up"
                href="/dashboard/calendar"
              />
              <QuickAction
                icon={BellRing}
                label="Send reminder"
                onClick={() =>
                  toast(
                    "Reminders fire from your automations. Configure cadence in Settings → Communications.",
                    "info",
                  )
                }
              />
            </div>
          </div>
        </div>
      </div>

      {/* AI Assistance micro-panel — rule-derived, never robotic */}
      <ThreadAIAssist thread={thread} />

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

// ─── Warmth + quick-action helpers ─────────────────────────────────

function WarmthChips({ thread }: { thread: Thread }) {
  const w = deriveWarmth(thread);
  const chips: Array<{ label: string; icon: LucideIcon; tone: string }> = [];
  if (w.touches >= 5) {
    chips.push({
      label: `${w.touches} touchpoints`,
      icon: MessageSquare,
      tone: "bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15",
    });
  }
  if (w.longevityDays >= 90) {
    chips.push({
      label: "Long-term",
      icon: Heart,
      tone: "bg-emerald-50/70 text-emerald-700 ring-1 ring-emerald-200/40",
    });
  }
  if (w.highlyEngaged) {
    chips.push({
      label: "Highly engaged",
      icon: Flame,
      tone: "bg-amber-50/70 text-amber-700 ring-1 ring-amber-200/40",
    });
  }
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((c) => {
        const I = c.icon;
        return (
          <span
            key={c.label}
            className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider", c.tone)}
          >
            <I className="h-2.5 w-2.5" strokeWidth={2} />
            {c.label}
          </span>
        );
      })}
    </>
  );
}

function QuickAction({
  icon: Icon,
  label,
  onClick,
  href,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  href?: string;
  tone?: "neutral" | "brand";
}) {
  const cls = cn(
    "inline-flex h-7 items-center gap-1 rounded-md border bg-surface px-2 text-[10px] font-semibold shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-md",
    tone === "brand"
      ? "border-brand-accent/30 text-brand-accent hover:bg-brand-subtle/40"
      : "border-border text-ink-muted hover:bg-surface-inset hover:text-ink",
  );
  if (href) {
    return (
      <Link href={href} className={cls}>
        <Icon className="h-3 w-3" strokeWidth={1.75} />
        {label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      <Icon className="h-3 w-3" strokeWidth={1.75} />
      {label}
    </button>
  );
}

/**
 * AI Assistance micro-panel. Renders a calm rule-derived suggestion
 * for the active thread — never a robotic "recommendation engine".
 * Always renders so the panel never reads as un-intelligent.
 */
function ThreadAIAssist({ thread }: { thread: Thread }) {
  const now = Date.now();
  const latestMs = new Date(thread.latest.createdAt).getTime();
  const ageDays = Math.floor((now - latestMs) / 86_400_000);
  const failedRecently = thread.logs.some(
    (l) => l.status === "failed" && now - new Date(l.createdAt).getTime() < 7 * 86_400_000,
  );
  const successfulRecently = thread.logs.some(
    (l) => l.status === "sent" && now - new Date(l.createdAt).getTime() < 24 * 3_600_000,
  );
  const isVip = thread.customerStatus === "vip";
  const hasUpcomingBooking =
    !!thread.bookingId &&
    !!thread.latest.bookingStartAt &&
    new Date(thread.latest.bookingStartAt).getTime() > now;

  let suggestion: string;
  let kind: "info" | "warn" | "calm" = "info";

  if (failedRecently) {
    suggestion = "Recent delivery failed. Consider resending via an alternate channel — SMS or a manual outreach.";
    kind = "warn";
  } else if (hasUpcomingBooking && isVip) {
    suggestion = "Upcoming VIP booking. A short personal pre-check note typically lifts retention by ~15%.";
    kind = "info";
  } else if (hasUpcomingBooking) {
    suggestion = "Upcoming booking on the calendar. Reminder automations will handle the standard touchpoint.";
    kind = "calm";
  } else if (ageDays >= 14 && isVip) {
    suggestion = `Last contact ${ageDays}d ago — VIP relationship goes dormant after 30d. Recommend a check-in this week.`;
    kind = "warn";
  } else if (ageDays >= 14) {
    suggestion = `Last contact ${ageDays}d ago. Consider a light-touch check-in to keep the relationship warm.`;
    kind = "info";
  } else if (successfulRecently) {
    suggestion = "Recent touchpoint delivered cleanly. No action needed — the automation is doing its job.";
    kind = "calm";
  } else if (ageDays >= 3) {
    suggestion = `Last contact ${ageDays}d ago. Within normal range; nothing to chase.`;
    kind = "calm";
  } else {
    suggestion = "Communication rhythm is healthy. No action needed.";
    kind = "calm";
  }

  const dotClass =
    kind === "warn" ? "bg-amber-500"
    : kind === "info" ? "bg-brand-accent"
    : "bg-emerald-500";

  return (
    <div className="border-b border-border/70 px-5 py-3">
      <div className="relative overflow-hidden rounded-xl border border-brand-accent/15 bg-gradient-to-r from-brand-subtle/45 via-surface to-surface shadow-soft">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
        />
        <div className="relative flex items-start gap-3 px-3.5 py-3">
          <div className="zm-pulse-glow relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_4px_10px_rgba(37,99,235,0.32)]">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
            <span aria-hidden className="absolute -right-0.5 -top-0.5 inline-flex h-2 w-2 items-center justify-center">
              <span className={cn("absolute inset-0 animate-ping rounded-full opacity-55", dotClass)} />
              <span className={cn("relative h-1.5 w-1.5 rounded-full ring-2 ring-surface", dotClass)} />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
                AI assistance
              </span>
              <ConfidenceChip level={deriveConfidence(thread)} />
              <EngagementChip level={deriveEngagement(thread)} />
            </div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink">{suggestion}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfidenceChip({ level }: { level: Confidence }) {
  const map: Record<Confidence, { label: string; cls: string; dot: string }> = {
    high:   { label: "High",   cls: "bg-emerald-50/80 text-emerald-700 ring-1 ring-emerald-200/40", dot: "bg-emerald-500" },
    medium: { label: "Medium", cls: "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15", dot: "bg-brand-accent" },
    low:    { label: "Low",    cls: "bg-surface-inset text-ink-subtle ring-1 ring-border/40",          dot: "bg-ink-subtle/50" },
  };
  const m = map[level];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]", m.cls)}>
      <span aria-hidden className={cn("inline-block h-1 w-1 rounded-full", m.dot)} />
      Confidence · {m.label}
    </span>
  );
}

function EngagementChip({ level }: { level: Engagement }) {
  const map: Record<Engagement, { label: string; cls: string; dot: string }> = {
    strong:  { label: "Strong",  cls: "bg-emerald-50/80 text-emerald-700 ring-1 ring-emerald-200/40", dot: "bg-emerald-500" },
    steady:  { label: "Steady",  cls: "bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15", dot: "bg-brand-accent" },
    cooling: { label: "Cooling", cls: "bg-amber-50/70 text-amber-700 ring-1 ring-amber-200/40",        dot: "bg-amber-500" },
  };
  const m = map[level];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]", m.cls)}>
      <span aria-hidden className={cn("inline-block h-1 w-1 rounded-full", m.dot)} />
      Engagement · {m.label}
    </span>
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
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-br from-brand-accent to-brand-hover px-3 text-[12px] font-medium text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(37,99,235,0.45)]"
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
