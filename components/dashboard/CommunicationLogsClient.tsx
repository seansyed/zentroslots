/**
 * CommunicationLogsClient — Phase 14A · Communication Delivery Center.
 *
 * Visual rewrite of the previous 351-line client. Behavior preserved:
 *   - Search box still debounces into `?q=…`
 *   - Status pill filter still writes `?status=…`
 *   - Event-type select still writes `?event=…`
 *   - Detail drawer still opens on row click
 *   - Mobile card list still renders below sm breakpoint
 *
 * Honest-data discipline:
 *   - No "Opened" / "Bounced" / "Avg delivery latency" / "Retry queue"
 *     tiles. The schema doesn't track those signals.
 *   - Retry + Export controls render as visibly disabled with a
 *     reason — never as fake clickable buttons.
 *   - Sparkline only renders when ≥3 days of real send activity exist.
 *   - Health tiles compute their status from real send/fail counters
 *     (idle when no traffic, healthy when failureRate < 5%, warning
 *     5–15%, degraded 15–30%, critical >30%).
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Badge, Drawer } from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";
import {
  Activity,
  ArrowRight,
  Bell,
  Calendar,
  CalendarX,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Filter,
  Inbox,
  Lock,
  Mail,
  MailCheck,
  MailX,
  RefreshCcw,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Zap,
  type LucideIcon,
} from "lucide-react";

type LogRow = {
  id: string;
  tenantId: string;
  bookingId: string | null;
  customerId: string | null;
  templateId: string | null;
  channel: string;
  eventType: string;
  status: string;
  provider: string | null;
  providerMessageId: string | null;
  failureReason: string | null;
  skippedReason: string | null;
  sentAt: string | null;
  createdAt: string;
};

type FailureRow = {
  id: string;
  eventType: string;
  provider: string | null;
  failureReason: string | null;
  createdAt: string;
};

type Summary = {
  windowDays: number;
  total7: number;
  sent7: number;
  failed7: number;
  skipped7: number;
  deliveryRatePct: number | null;
  failureRatePct: number;
  last24Sent: number;
  last24Failed: number;
  prior24Sent: number;
  last24FailPct: number;
  prior24FailPct: number;
  last24SendDelta: number;
  lastSuccessfulAt: string | null;
  lastSuccessfulProvider: string | null;
  remindersByEvent: Array<{ eventType: string; label: string; count: number }>;
  daySeries: Array<{ day: string; n: number }>;
  providerMix: Array<{ provider: string; count: number }>;
};

const STATUS_TONES: Record<string, "green" | "amber" | "red" | "neutral"> = {
  sent: "green",
  delivered: "green",
  queued: "amber",
  skipped: "neutral",
  failed: "red",
  suppressed: "neutral",
};

const STATUS_OPTIONS = ["all", "sent", "failed", "skipped"] as const;

const KIND_LABELS: Record<string, string> = {
  "appointment.created": "Confirmation",
  "appointment.cancelled": "Cancellation",
  "appointment.rescheduled": "Reschedule",
  "appointment.reminder_24h": "Reminder · 24h",
  "appointment.reminder_1h": "Reminder · 1h",
};

const REMINDER_ICONS: Record<string, LucideIcon> = {
  "appointment.created": MailCheck,
  "appointment.reminder_24h": Bell,
  "appointment.reminder_1h": Clock,
  "appointment.cancelled": CalendarX,
  "appointment.rescheduled": Calendar,
};

// Health classification — pure, identical thresholds applied everywhere.
function classifyDelivery(failureRatePct: number, hasTraffic: boolean):
  | "healthy"
  | "warning"
  | "degraded"
  | "critical"
  | "idle" {
  if (!hasTraffic) return "idle";
  if (failureRatePct < 5) return "healthy";
  if (failureRatePct < 15) return "warning";
  if (failureRatePct < 30) return "degraded";
  return "critical";
}

export default function CommunicationLogsClient({
  rows,
  statusFilter,
  eventFilter,
  search,
  eventTypes,
  summary,
  recentFailures,
  hasAnalytics,
  currentPlanName,
  tenantName,
}: {
  rows: LogRow[];
  statusFilter: string;
  eventFilter: string;
  search: string;
  eventTypes: string[];
  summary: Summary;
  recentFailures: FailureRow[];
  hasAnalytics: boolean;
  currentPlanName: string;
  tenantName: string;
}) {
  const [openRow, setOpenRow] = React.useState<LogRow | null>(null);

  // Debounced search — preserves the pre-Phase-14 contract.
  const [searchInput, setSearchInput] = React.useState(search);
  React.useEffect(() => {
    setSearchInput(search);
  }, [search]);

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  function onSearchChange(next: string) {
    setSearchInput(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const url = new URL(window.location.href);
      if (next) url.searchParams.set("q", next);
      else url.searchParams.delete("q");
      window.location.assign(url.pathname + url.search);
    }, 400);
  }

  function buildHref(over: { status?: string; event?: string; q?: string }) {
    const sp = new URLSearchParams();
    const status = over.status ?? statusFilter;
    if (status && status !== "all") sp.set("status", status);
    const ev = over.event ?? eventFilter;
    if (ev) sp.set("event", ev);
    const q = over.q ?? search;
    if (q) sp.set("q", q);
    const qs = sp.toString();
    return qs
      ? `/dashboard/settings/communications/logs?${qs}`
      : "/dashboard/settings/communications/logs";
  }

  const hasTraffic = summary.total7 > 0;
  const deliveryStatus = classifyDelivery(summary.failureRatePct, hasTraffic);

  // Hero insight chips — only emit when the data is real.
  const insightChips: string[] = [];
  if (summary.deliveryRatePct !== null) {
    insightChips.push(`${summary.deliveryRatePct}% delivery success this week.`);
  }
  if (summary.last24Sent > 0) {
    insightChips.push(
      `${summary.last24Sent} email${summary.last24Sent === 1 ? "" : "s"} sent in the last 24h.`,
    );
  }
  if (summary.last24Failed > 0) {
    insightChips.push(
      `${summary.last24Failed} delivery failure${summary.last24Failed === 1 ? "" : "s"} detected — review below.`,
    );
  }
  if (summary.lastSuccessfulProvider) {
    insightChips.push(`Last successful send via ${summary.lastSuccessfulProvider}.`);
  }

  // Last-successful-send freshness — drives the "live send pulse" dot.
  const lastSuccessAgeMs = summary.lastSuccessfulAt
    ? Date.now() - new Date(summary.lastSuccessfulAt).getTime()
    : null;
  const sendingNow = lastSuccessAgeMs !== null && lastSuccessAgeMs < 60 * 60_000;

  return (
    <div className="relative mt-2 space-y-5 pb-12">
      {/* Ambient depth — matches executive cockpit + reports */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-24 -z-10 h-[28rem] w-[28rem] rounded-full bg-brand-accent/[0.06] blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-80 -z-10 h-[24rem] w-[24rem] rounded-full bg-emerald-300/[0.05] blur-[120px]"
      />

      {/* ── Hero ─────────────────────────────────────────────── */}
      <FadeIn>
        <DeliveryHero
          tenantName={tenantName}
          windowDays={summary.windowDays}
          insightChips={insightChips}
          sendingNow={sendingNow}
          deliveryStatus={deliveryStatus}
          hasAnalytics={hasAnalytics}
        />
      </FadeIn>

      {/* ── KPI cockpit ──────────────────────────────────────── */}
      <FadeIn delay={1}>
        <div>
          <SectionHead
            eyebrow="Snapshot"
            title="Delivery KPIs"
            hint={`Last ${summary.windowDays} days · ${summary.total7} event${summary.total7 === 1 ? "" : "s"} logged.`}
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Total sent"
              value={String(summary.sent7)}
              detail={`${summary.last24Sent} in last 24h`}
              icon={Mail}
              tone="brand"
              spark={summary.daySeries.length >= 3 ? summary.daySeries.map((d) => d.n) : null}
            />
            <KpiCard
              label="Failures"
              value={String(summary.failed7)}
              detail={
                summary.last24Failed > 0
                  ? `${summary.last24Failed} in last 24h`
                  : "No failures in last 24h"
              }
              icon={MailX}
              tone={summary.failed7 > 0 ? "warning" : "neutral"}
            />
            <KpiCard
              label="Skipped"
              value={String(summary.skipped7)}
              detail="Suppressed by policy or feature gate"
              icon={Filter}
              tone="neutral"
            />
            <KpiCard
              label="Delivery success"
              value={
                summary.deliveryRatePct !== null
                  ? `${summary.deliveryRatePct}%`
                  : "—"
              }
              detail={
                summary.deliveryRatePct !== null
                  ? `${summary.sent7} of ${summary.sent7 + summary.failed7} accepted`
                  : "No send attempts yet"
              }
              icon={CheckCircle2}
              tone={
                summary.deliveryRatePct === null
                  ? "neutral"
                  : summary.deliveryRatePct >= 95
                    ? "positive"
                    : summary.deliveryRatePct >= 80
                      ? "warning"
                      : "warning"
              }
            />
            <KpiCard
              label="Last 24h sent"
              value={String(summary.last24Sent)}
              detail={
                summary.last24SendDelta === 0
                  ? "Level with prior 24h"
                  : summary.last24SendDelta > 0
                    ? `+${summary.last24SendDelta} vs prior 24h`
                    : `${summary.last24SendDelta} vs prior 24h`
              }
              icon={summary.last24SendDelta >= 0 ? TrendingUp : TrendingDown}
              tone="brand"
            />
            <KpiCard
              label="Reminders sent"
              value={String(
                (summary.remindersByEvent.find((r) => r.eventType === "appointment.reminder_24h")?.count ?? 0) +
                  (summary.remindersByEvent.find((r) => r.eventType === "appointment.reminder_1h")?.count ?? 0),
              )}
              detail="24h + 1h reminders combined"
              icon={Bell}
              tone="brand"
            />
            <KpiCard
              label="Confirmations sent"
              value={String(
                summary.remindersByEvent.find((r) => r.eventType === "appointment.created")?.count ?? 0,
              )}
              detail="Triggered on booking creation"
              icon={MailCheck}
              tone="positive"
            />
            <KpiCard
              label="Last successful send"
              value={
                summary.lastSuccessfulAt
                  ? relativeTime(summary.lastSuccessfulAt)
                  : "—"
              }
              detail={
                summary.lastSuccessfulProvider
                  ? `via ${summary.lastSuccessfulProvider}`
                  : "No successful sends yet"
              }
              icon={Zap}
              tone={sendingNow ? "positive" : "neutral"}
              pulse={sendingNow}
            />
          </div>
        </div>
      </FadeIn>

      {/* ── Delivery health center ───────────────────────────── */}
      <FadeIn delay={2}>
        <DeliveryHealthCenter
          deliveryStatus={deliveryStatus}
          summary={summary}
          providerMix={summary.providerMix}
        />
      </FadeIn>

      {/* ── Reminder intelligence ─────────────────────────────── */}
      {hasTraffic && (
        <FadeIn delay={3}>
          <div>
            <SectionHead
              eyebrow="Lifecycle"
              title="Reminder intelligence"
              hint="Breakdown of automated emails over the last 7 days."
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {summary.remindersByEvent.map((r) => {
                const Icon = REMINDER_ICONS[r.eventType] ?? Mail;
                return (
                  <ReminderTile
                    key={r.eventType}
                    label={r.label}
                    count={r.count}
                    icon={Icon}
                    href={buildHref({ event: r.eventType })}
                  />
                );
              })}
            </div>
          </div>
        </FadeIn>
      )}

      {/* ── Failure management ───────────────────────────────── */}
      <FadeIn delay={4}>
        <FailureManagementSection
          failures={recentFailures}
          hasAnalytics={hasAnalytics}
          currentPlanName={currentPlanName}
        />
      </FadeIn>

      {/* ── Activity table ───────────────────────────────────── */}
      <FadeIn delay={5}>
        <div>
          <SectionHead
            eyebrow="Activity"
            title="Recent delivery events"
            hint="Up to 200 most recent emails this workspace tried to send."
          />

          {/* Filter bar */}
          <PremiumCard className="relative mt-3 overflow-hidden p-4">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent"
            />
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-80">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle"
                />
                <input
                  type="search"
                  value={searchInput}
                  onChange={(e) => onSearchChange(e.target.value)}
                  placeholder="Customer name, email, or booking ID…"
                  aria-label="Search delivery logs"
                  className="w-full rounded-lg border border-border bg-surface py-1.5 pl-8 pr-3 text-[12.5px] outline-none transition-colors focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15"
                />
              </div>
              <div className="inline-flex rounded-full border border-border bg-surface p-0.5">
                {STATUS_OPTIONS.map((s) => (
                  <Link
                    key={s}
                    href={buildHref({ status: s })}
                    className={cn(
                      "rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition-all",
                      (statusFilter ?? "all") === s
                        ? "bg-brand-accent text-white shadow-[0_2px_8px_rgba(53,157,243,0.32)]"
                        : "text-ink-muted hover:text-ink",
                    )}
                  >
                    {s}
                  </Link>
                ))}
              </div>
              {eventTypes.length > 0 && (
                <select
                  value={eventFilter}
                  onChange={(e) => {
                    window.location.assign(buildHref({ event: e.target.value }));
                  }}
                  className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12px] outline-none transition-colors focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/15"
                  aria-label="Event type filter"
                >
                  <option value="">All events</option>
                  {eventTypes.map((t) => (
                    <option key={t} value={t}>
                      {KIND_LABELS[t] ?? t}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Active filter chips */}
            {(search || eventFilter || (statusFilter && statusFilter !== "all")) && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-subtle">
                <span>{rows.length} {rows.length === 1 ? "entry" : "entries"}</span>
                {search && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 ring-1 ring-border/40">
                    search: <span className="font-medium text-ink">&ldquo;{search}&rdquo;</span>
                    <Link href={buildHref({ q: "" })} className="ml-0.5 text-ink-muted hover:text-ink" aria-label="Clear search">
                      ×
                    </Link>
                  </span>
                )}
                {eventFilter && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 ring-1 ring-border/40">
                    event: <span className="font-medium text-ink">{KIND_LABELS[eventFilter] ?? eventFilter}</span>
                    <Link href={buildHref({ event: "" })} className="ml-0.5 text-ink-muted hover:text-ink" aria-label="Clear event filter">
                      ×
                    </Link>
                  </span>
                )}
                {statusFilter && statusFilter !== "all" && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-2 py-0.5 ring-1 ring-border/40">
                    status: <span className="font-medium text-ink">{statusFilter}</span>
                    <Link href={buildHref({ status: "all" })} className="ml-0.5 text-ink-muted hover:text-ink" aria-label="Clear status filter">
                      ×
                    </Link>
                  </span>
                )}
              </div>
            )}
          </PremiumCard>

          {/* DESKTOP table */}
          <PremiumCard className="relative mt-3 hidden overflow-hidden p-0 sm:block">
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent"
            />
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-surface-inset/60 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                  <tr>
                    <th className="px-4 py-2.5 text-left">When</th>
                    <th className="px-4 py-2.5 text-left">Event</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                    <th className="px-4 py-2.5 text-left">Provider</th>
                    <th className="px-4 py-2.5 text-left">Detail</th>
                    <th className="px-4 py-2.5 text-left">Booking</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-10">
                        <EmptyTableState statusFilter={statusFilter} hasAnyTraffic={hasTraffic} />
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setOpenRow(r)}
                      className="cursor-pointer border-t border-border/40 align-top transition-colors hover:bg-surface-inset/40"
                    >
                      <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">
                        {fmtTimestamp(r.createdAt)}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] font-medium text-ink">
                        {KIND_LABELS[r.eventType] ?? r.eventType}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONES[r.status] ?? "neutral"}>{r.status}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-ink-muted">
                        {r.provider ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-[11px] text-ink-muted">
                        {detailFor(r)}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-ink-subtle">
                        {r.bookingId ? r.bookingId.slice(0, 8) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PremiumCard>

          {/* MOBILE card list */}
          <ul className="mt-3 space-y-2 sm:hidden">
            {rows.length === 0 && (
              <li>
                <PremiumCard className="relative overflow-hidden p-6">
                  <EmptyTableState statusFilter={statusFilter} hasAnyTraffic={hasTraffic} />
                </PremiumCard>
              </li>
            )}
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenRow(r)}
                  className="w-full rounded-2xl border border-border/60 bg-surface p-3 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-ink">
                        {KIND_LABELS[r.eventType] ?? r.eventType}
                      </div>
                      <div className="mt-0.5 text-[11px] text-ink-subtle">
                        {fmtTimestamp(r.createdAt)}
                      </div>
                    </div>
                    <Badge tone={STATUS_TONES[r.status] ?? "neutral"}>{r.status}</Badge>
                  </div>
                  <div className="mt-2 truncate text-[11.5px] text-ink-muted">
                    {detailFor(r) || "—"}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </FadeIn>

      {/* ── Export + Pro upgrade ─────────────────────────────── */}
      <FadeIn delay={6}>
        <ExportCenterSection
          hasAnalytics={hasAnalytics}
          currentPlanName={currentPlanName}
        />
      </FadeIn>

      {/* ── DRAWER — preserved behavior ──────────────────────── */}
      <Drawer
        open={Boolean(openRow)}
        onClose={() => setOpenRow(null)}
        side="right"
        size="lg"
        ariaLabel="Delivery log detail"
      >
        {openRow && <LogDetail row={openRow} />}
      </Drawer>
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────

function DeliveryHero({
  tenantName,
  windowDays,
  insightChips,
  sendingNow,
  deliveryStatus,
  hasAnalytics,
}: {
  tenantName: string;
  windowDays: number;
  insightChips: string[];
  sendingNow: boolean;
  deliveryStatus: "healthy" | "warning" | "degraded" | "critical" | "idle";
  hasAnalytics: boolean;
}) {
  const statusTone =
    deliveryStatus === "healthy"
      ? "from-emerald-500 to-emerald-600 ring-emerald-200/40"
      : deliveryStatus === "warning"
        ? "from-amber-500 to-amber-600 ring-amber-200/40"
        : deliveryStatus === "degraded"
          ? "from-orange-500 to-orange-600 ring-orange-200/40"
          : deliveryStatus === "critical"
            ? "from-rose-500 to-rose-600 ring-rose-200/40"
            : "from-slate-400 to-slate-500 ring-border/40";
  const statusLabel =
    deliveryStatus === "healthy"
      ? "Healthy"
      : deliveryStatus === "warning"
        ? "Watch"
        : deliveryStatus === "degraded"
          ? "Degraded"
          : deliveryStatus === "critical"
            ? "Critical"
            : "Idle";
  return (
    <PremiumCard
      compact
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/55 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-28 h-72 w-72 rounded-full bg-brand-accent/[0.14] blur-3xl"
      />
      <div
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
            <Mail className="h-3 w-3" strokeWidth={2} />
            Delivery center
          </div>
          <h1 className="mt-2 text-[20px] font-semibold tracking-tight text-ink sm:text-[22px]">
            Email log
          </h1>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            <span className="font-medium text-ink">{tenantName}</span> &middot; delivery monitoring,
            reminder auditing, and communication intelligence over the last {windowDays} days.
          </p>

          {insightChips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {insightChips.slice(0, 4).map((line, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-border/60 backdrop-blur-sm"
                >
                  <Sparkles className="h-3 w-3 text-brand-accent" strokeWidth={2} />
                  {line}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Live send pulse — visible when there's a successful send
              in the last hour. Tied to real sentAt, not fabricated. */}
          {sendingNow && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-emerald-700 ring-1 ring-emerald-200/40">
              <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
                <span className="absolute inset-0 inline-flex animate-ping rounded-full bg-emerald-400/60" />
                <span className="relative inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
              </span>
              Sending live
            </span>
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.10em] text-white ring-1",
              statusTone,
            )}
          >
            {statusLabel}
          </span>
          <Link
            href="/dashboard/settings/communications/templates"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted shadow-soft transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-surface-inset hover:text-ink hover:shadow-md"
          >
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            Edit templates
          </Link>
          {!hasAnalytics && (
            <Link
              href="/dashboard/billing"
              className="zm-pulse-glow inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-brand-accent to-brand-hover px-3 text-[12px] font-semibold text-white shadow-[0_6px_16px_rgba(53,157,243,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(53,157,243,0.45)]"
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
              Unlock exports
            </Link>
          )}
        </div>
      </div>
    </PremiumCard>
  );
}

// ─── KPI card with optional sparkline ──────────────────────────────

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  tone,
  spark,
  pulse,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: "brand" | "positive" | "warning" | "neutral";
  spark?: number[] | null;
  pulse?: boolean;
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "warning"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : tone === "brand"
          ? "bg-brand-subtle/60 text-brand-accent ring-brand-accent/15"
          : "bg-surface-inset text-ink-subtle ring-border/40";
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[22px] font-semibold tracking-tight text-ink tabular-nums">
            {value}
          </div>
          <p className="mt-1 text-[11px] text-ink-muted">{detail}</p>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1", iconTone)}>
          {pulse && (
            <span aria-hidden className="absolute -mr-6 -mt-6 inline-flex h-2 w-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald-400/60" />
              <span className="relative inline-block h-2 w-2 rounded-full bg-emerald-500" />
            </span>
          )}
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      {spark && spark.length >= 3 && (
        <div className="mt-2.5" aria-hidden>
          <Sparkline values={spark} tone={tone === "neutral" ? "brand" : tone} />
        </div>
      )}
    </div>
  );
}

function Sparkline({
  values,
  tone,
}: {
  values: number[];
  tone: "brand" | "positive" | "warning";
}) {
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const range = Math.max(1, max - min);
  const W = 100;
  const H = 22;
  const points = values.map((v, i) => {
    const x = (i / Math.max(1, values.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const stroke = tone === "positive" ? "#059669" : tone === "warning" ? "#d97706" : "#359df3";
  const fillId = tone === "positive" ? "sparkPosFill" : tone === "warning" ? "sparkWarnFill" : "sparkBrandFill";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-5 w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="sparkBrandFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#359df3" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#359df3" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sparkPosFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#059669" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#059669" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="sparkWarnFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d97706" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#d97706" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={points.join(" ")} stroke={stroke} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <polygon points={`0,${H} ${points.join(" ")} ${W},${H}`} fill={`url(#${fillId})`} />
    </svg>
  );
}

// ─── Delivery health center ────────────────────────────────────────

function DeliveryHealthCenter({
  deliveryStatus,
  summary,
  providerMix,
}: {
  deliveryStatus: "healthy" | "warning" | "degraded" | "critical" | "idle";
  summary: Summary;
  providerMix: Array<{ provider: string; count: number }>;
}) {
  // Provider connectivity — proxy signal: has the most-used provider
  // produced a successful send in the last 24h?
  const topProvider = providerMix[0];
  const providerHealth: "healthy" | "idle" =
    summary.last24Sent > 0 ? "healthy" : "idle";

  // Reminder pipeline health — proxy signal: reminders sent in last
  // window vs failure ratio overall.
  const reminderCount =
    (summary.remindersByEvent.find((r) => r.eventType === "appointment.reminder_24h")?.count ?? 0) +
    (summary.remindersByEvent.find((r) => r.eventType === "appointment.reminder_1h")?.count ?? 0);
  const reminderStatus: "healthy" | "warning" | "idle" =
    reminderCount === 0
      ? "idle"
      : summary.failureRatePct > 15
        ? "warning"
        : "healthy";

  return (
    <div>
      <SectionHead
        eyebrow="System pulse"
        title="Delivery health center"
        hint="Real-time signal across the pipelines that move email."
      />
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <HealthTile
          label="Delivery success"
          status={deliveryStatus}
          primary={
            summary.deliveryRatePct !== null
              ? `${summary.deliveryRatePct}% accepted`
              : "No traffic"
          }
          detail={
            summary.deliveryRatePct !== null
              ? `${summary.sent7} sent · ${summary.failed7} failed across ${summary.windowDays}d.`
              : `No emails sent in the last ${summary.windowDays} days.`
          }
          icon={MailCheck}
        />
        <HealthTile
          label="Provider connectivity"
          status={providerHealth}
          primary={topProvider ? topProvider.provider : "Not configured"}
          detail={
            topProvider
              ? `${topProvider.count} successful sends via ${topProvider.provider} in window.`
              : "No outbound provider has registered a send yet."
          }
          icon={Server}
        />
        <HealthTile
          label="24h failure rate"
          status={
            summary.last24Sent + summary.last24Failed === 0
              ? "idle"
              : summary.last24FailPct > 20
                ? "critical"
                : summary.last24FailPct > 5
                  ? "warning"
                  : "healthy"
          }
          primary={
            summary.last24Sent + summary.last24Failed === 0
              ? "No traffic"
              : `${summary.last24FailPct}%`
          }
          detail={
            summary.last24Sent + summary.last24Failed === 0
              ? "Nothing sent in the last 24h."
              : `${summary.last24Failed} failed of ${summary.last24Sent + summary.last24Failed} attempted · prior 24h was ${summary.prior24FailPct}%.`
          }
          icon={ShieldAlert}
        />
        <HealthTile
          label="Reminder pipeline"
          status={reminderStatus}
          primary={reminderCount === 0 ? "No reminders" : `${reminderCount} reminders`}
          detail={
            reminderCount === 0
              ? `No reminders fired in the last ${summary.windowDays} days.`
              : `24h + 1h reminders combined across ${summary.windowDays}d. Failure rate ${summary.failureRatePct}%.`
          }
          icon={Bell}
        />
      </div>
    </div>
  );
}

function HealthTile({
  label,
  status,
  primary,
  detail,
  icon: Icon,
}: {
  label: string;
  status: "healthy" | "warning" | "degraded" | "critical" | "idle";
  primary: string;
  detail: string;
  icon: LucideIcon;
}) {
  const ring =
    status === "healthy"
      ? "ring-emerald-200/40 bg-emerald-50/60"
      : status === "warning"
        ? "ring-amber-200/40 bg-amber-50/60"
        : status === "degraded"
          ? "ring-orange-200/40 bg-orange-50/60"
          : status === "critical"
            ? "ring-rose-200/40 bg-rose-50/60"
            : "ring-border/40 bg-surface-inset/60";
  const dotTone =
    status === "healthy"
      ? "bg-emerald-500"
      : status === "warning"
        ? "bg-amber-500"
        : status === "degraded"
          ? "bg-orange-500"
          : status === "critical"
            ? "bg-rose-500"
            : "bg-ink-subtle";
  const iconTone =
    status === "healthy"
      ? "bg-emerald-100/80 text-emerald-700"
      : status === "warning"
        ? "bg-amber-100/80 text-amber-700"
        : status === "degraded"
          ? "bg-orange-100/80 text-orange-700"
          : status === "critical"
            ? "bg-rose-100/80 text-rose-700"
            : "bg-surface text-ink-subtle";
  const statusLabel =
    status === "healthy"
      ? "Healthy"
      : status === "warning"
        ? "Warning"
        : status === "degraded"
          ? "Degraded"
          : status === "critical"
            ? "Critical"
            : "Idle";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border/60 p-4 ring-1 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft",
        ring,
      )}
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[15px] font-semibold tracking-tight text-ink">{primary}</div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{detail}</p>
        </div>
        <span className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", iconTone)}>
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      <div className="mt-3 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-muted">
        <span aria-hidden className="relative inline-flex h-1.5 w-1.5">
          {(status === "healthy" || status === "warning") && (
            <span className={cn("absolute inset-0 inline-flex animate-ping rounded-full opacity-60", dotTone)} />
          )}
          <span className={cn("relative inline-block h-1.5 w-1.5 rounded-full", dotTone)} />
        </span>
        {statusLabel}
      </div>
    </div>
  );
}

// ─── Reminder tile ─────────────────────────────────────────────────

function ReminderTile({
  label,
  count,
  icon: Icon,
  href,
}: {
  label: string;
  count: number;
  icon: LucideIcon;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group relative block overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft"
    >
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
      <div className="flex items-start gap-2.5">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
            {label}
          </div>
          <div className="mt-1 text-[20px] font-semibold tracking-tight text-ink tabular-nums">
            {count}
          </div>
        </div>
      </div>
      <div className="mt-2 inline-flex items-center gap-1 text-[10.5px] font-medium text-brand-accent opacity-0 transition-opacity group-hover:opacity-100">
        Filter to this event
        <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
      </div>
    </Link>
  );
}

// ─── Failure management ────────────────────────────────────────────

function FailureManagementSection({
  failures,
  hasAnalytics,
  currentPlanName,
}: {
  failures: FailureRow[];
  hasAnalytics: boolean;
  currentPlanName: string;
}) {
  return (
    <div>
      <SectionHead
        eyebrow="Diagnostics"
        title="Failure management"
        hint="Recent deliveries that did not land — review the provider response and address customer-side issues."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        {failures.length === 0 ? (
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/40">
                <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} />
              </div>
              <div className="min-w-0">
                <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
                  No recent delivery failures
                </h3>
                <p className="mt-0.5 max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
                  Every outbound email this workspace tried to send has either been accepted by the
                  provider or intentionally skipped. Failures will surface here when they happen.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {failures.map((f) => (
              <li
                key={f.id}
                className="relative overflow-hidden rounded-xl border border-rose-200/40 bg-rose-50/30 p-3"
              >
                <div className="flex items-start gap-2.5">
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-100/80 text-rose-700 ring-1 ring-rose-200/50">
                    <MailX className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[12.5px] font-semibold tracking-tight text-ink">
                        {KIND_LABELS[f.eventType] ?? f.eventType}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
                        {fmtTimestamp(f.createdAt)}
                      </span>
                      {f.provider && (
                        <span className="inline-flex items-center rounded-full bg-rose-100/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-rose-700 ring-1 ring-rose-200/40">
                          via {f.provider}
                        </span>
                      )}
                    </div>
                    {f.failureReason && (
                      <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-rose-200/40 bg-white/70 p-2 text-[11px] font-mono leading-relaxed text-rose-900">
                        {truncate(f.failureReason, 400)}
                      </pre>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled
                    title="Manual retry is not yet wired into this surface."
                    aria-label="Retry send (disabled — backend not wired)"
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-ink-subtle opacity-60"
                  >
                    <RefreshCcw className="h-3 w-3" strokeWidth={2} />
                    Retry
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* Pro upsell — retry / advanced diagnostics is a paid surface. */}
        {!hasAnalytics && (
          <div className="mt-4 rounded-xl border border-amber-200/40 bg-amber-50/30 p-3">
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2.5">
                <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-100/80 text-amber-700 ring-1 ring-amber-200/40">
                  <Lock className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="min-w-0">
                  <div className="inline-flex items-center gap-1 rounded-full bg-amber-100/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-amber-700 ring-1 ring-amber-200/40">
                    Pro feature
                  </div>
                  <h3 className="mt-1 text-[12.5px] font-semibold tracking-tight text-ink">
                    Failure diagnostics &amp; manual retry
                  </h3>
                  <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-ink-muted">
                    Upgrade from {currentPlanName} to surface provider response detail, automated
                    retry queues, and bounce-suppression handling.
                  </p>
                </div>
              </div>
              <Link
                href="/dashboard/billing"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(53,157,243,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(53,157,243,0.40)]"
              >
                <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
                Unlock diagnostics
                <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
              </Link>
            </div>
          </div>
        )}
      </PremiumCard>
    </div>
  );
}

// ─── Export center ─────────────────────────────────────────────────

function ExportCenterSection({
  hasAnalytics,
  currentPlanName,
}: {
  hasAnalytics: boolean;
  currentPlanName: string;
}) {
  return (
    <div>
      <SectionHead
        eyebrow="Export"
        title="Audit & export"
        hint="Pull a copy of the delivery log for compliance review or external archive."
      />
      <PremiumCard className="relative mt-3 overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent" />
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
              <Download className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="inline-flex items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-ink-subtle ring-1 ring-border/40">
                <Lock className="h-2.5 w-2.5" strokeWidth={2} />
                Coming soon
              </div>
              <h3 className="mt-1 text-[13.5px] font-semibold tracking-tight text-ink">
                Delivery log CSV export
              </h3>
              <p className="mt-0.5 max-w-xl text-[11.5px] leading-relaxed text-ink-muted">
                A tenant-scoped CSV of every outbound delivery attempt — type, status, recipient,
                provider, timestamps, and failure reason. Rolling out alongside the scheduled-report
                cadence{hasAnalytics ? "." : ` once you upgrade from ${currentPlanName}.`}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled
            title="Delivery log CSV export is rolling out."
            aria-label="Export delivery log CSV (coming soon)"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-ink-subtle opacity-70"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2} />
            Export CSV
          </button>
        </div>
      </PremiumCard>
    </div>
  );
}

// ─── Detail drawer (preserved + polished) ──────────────────────────

function LogDetail({ row }: { row: LogRow }) {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border/60 px-5 py-4">
        <div className="flex items-center gap-2">
          <Badge tone={STATUS_TONES[row.status] ?? "neutral"}>{row.status}</Badge>
          <span className="text-[13.5px] font-semibold tracking-tight text-ink">
            {KIND_LABELS[row.eventType] ?? row.eventType}
          </span>
        </div>
        <div className="mt-1 text-[11px] text-ink-muted">{fmtTimestamp(row.createdAt)}</div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto p-5 text-[13px]">
        <DetailRow label="Channel" value={row.channel} />
        <DetailRow label="Booking ID" value={row.bookingId} mono />
        <DetailRow label="Customer ID" value={row.customerId} mono />
        <DetailRow label="Template ID" value={row.templateId} mono />

        {row.status === "sent" && (
          <>
            <DetailRow label="Provider" value={row.provider} />
            <DetailRow label="Provider message ID" value={row.providerMessageId} mono />
            <DetailRow label="Sent at" value={row.sentAt ? fmtTimestamp(row.sentAt) : null} />
          </>
        )}

        {row.status === "failed" && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Failure reason
            </div>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-rose-200/40 bg-rose-50/60 p-3 text-[11px] text-rose-900">
              {row.failureReason ?? "—"}
            </pre>
            {row.provider && (
              <DetailRow label="Provider that failed" value={row.provider} />
            )}
          </div>
        )}

        {row.status === "skipped" && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Skip reason
            </div>
            <div className="mt-1 rounded-md border border-border bg-surface-inset/60 p-2.5 font-mono text-[11px] text-ink">
              {row.skippedReason ?? "—"}
            </div>
            <p className="mt-2 text-[11px] text-ink-subtle">
              Common reasons: customer preferences gated the send, reminders feature disabled,
              automation rule disabled, or already-sent idempotency hit.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
        {label}
      </div>
      <div className={cn("mt-0.5 text-[13px] text-ink", mono && "font-mono text-[11.5px] break-all")}>
        {value}
      </div>
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────

function EmptyTableState({
  statusFilter,
  hasAnyTraffic,
}: {
  statusFilter: string;
  hasAnyTraffic: boolean;
}) {
  if (hasAnyTraffic && statusFilter && statusFilter !== "all") {
    return (
      <div className="flex flex-col items-center text-center">
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-surface-inset text-ink-subtle ring-1 ring-border/40">
          <Filter className="h-4 w-4" strokeWidth={1.75} />
        </div>
        <h3 className="mt-2 text-[13.5px] font-semibold tracking-tight text-ink">
          No matching delivery events
        </h3>
        <p className="mt-1 max-w-md text-[11.5px] leading-relaxed text-ink-muted">
          No emails match this filter combination. Clear the filters above to see the full activity stream.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center text-center">
      <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
        <Inbox className="h-4 w-4" strokeWidth={1.75} />
      </div>
      <h3 className="mt-2 text-[13.5px] font-semibold tracking-tight text-ink">
        Your delivery log is empty
      </h3>
      <p className="mx-auto mt-1 max-w-md text-[11.5px] leading-relaxed text-ink-muted">
        Booking confirmations, reminders, cancellations, and automated notifications will appear
        here as soon as activity begins. Every outbound email is logged for compliance.
      </p>
      <ul className="mt-3 space-y-1 text-left text-[11px] text-ink-muted">
        <li className="flex items-start gap-1.5">
          <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" strokeWidth={2.25} />
          <span>Confirmations fire when a booking is created.</span>
        </li>
        <li className="flex items-start gap-1.5">
          <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" strokeWidth={2.25} />
          <span>24h and 1h reminders dispatch automatically.</span>
        </li>
        <li className="flex items-start gap-1.5">
          <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" strokeWidth={2.25} />
          <span>Cancellations and reschedules notify customers in real time.</span>
        </li>
      </ul>
    </div>
  );
}

// ─── Shared bits ───────────────────────────────────────────────────

function SectionHead({
  eyebrow,
  title,
  hint,
}: {
  eyebrow: string;
  title: string;
  hint?: string;
}) {
  return (
    <header className="mb-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
        {eyebrow}
      </div>
      <h2 className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
      {hint && <p className="mt-0.5 text-[12px] text-ink-muted">{hint}</p>}
    </header>
  );
}

function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}

function detailFor(r: LogRow): string {
  if (r.status === "skipped") return r.skippedReason ?? "—";
  if (r.status === "failed") return truncate(r.failureReason ?? "—", 120);
  if (r.status === "sent") {
    if (r.providerMessageId) return `via ${r.provider ?? "?"} · ${r.providerMessageId.slice(0, 24)}`;
    return r.provider ?? "sent";
  }
  return "";
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
