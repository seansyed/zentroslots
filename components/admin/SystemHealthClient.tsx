"use client";

/**
 * SA-3 — Platform Health Center client.
 *
 * Single client component that orchestrates all four sections of
 * /admin/system-health:
 *
 *   A. Infrastructure health grid    (15 cards)
 *   B. Integration health matrix     (5 providers × 8 cols)
 *   C. Communications monitoring     (8 tiles + hourly graph)
 *   D. Live system feed              (infinite-scroll audit stream)
 *
 * Auto-refresh: a single 60s setInterval re-fetches all four
 * sections in parallel. The interval pauses while the document is
 * hidden (visibilitychange) to avoid wasted background polling.
 *
 * Per-section error isolation: any failed fetch leaves the prior
 * good data in place and shows a small "stale" chip; the other
 * sections keep refreshing.
 *
 * Initial data is server-rendered for fast first paint, then the
 * client takes over.
 */

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  CalendarSync,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  Filter,
  Loader2,
  Mail,
  RefreshCw,
  Server,
  Shield,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { InfrastructureHealth, HealthCard, HealthStatus } from "@/lib/admin-analytics/health";
import type { IntegrationsMatrix, IntegrationProvider } from "@/lib/admin-analytics/integrations";
import type { CommsMonitoring, CommsTile } from "@/lib/admin-analytics/comms";
import type { ActivityEvent, ActivityPage } from "@/lib/admin-analytics/activity";
import { deriveHealthMission, deriveHealthInsights } from "@/lib/admin-analytics/health-mission";
import HealthMissionHero, { HealthInsightChip } from "@/components/admin/HealthMissionHero";

// ─── Formatters ────────────────────────────────────────────────────

function fmt(card: HealthCard): string {
  if (card.value === null) return "—";
  switch (card.unit) {
    case "ms":
      return `${card.value}ms`;
    case "percent":
      return `${card.value}%`;
    case "bytes":
      return `${Math.round(Number(card.value) / 1024 / 1024)} MB`;
    case "duration_s": {
      const s = Number(card.value);
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.round(s / 60)}m`;
      return `${Math.round(s / 3600)}h`;
    }
    case "count":
      return new Intl.NumberFormat("en-US").format(Number(card.value));
    case "string":
      return String(card.value);
    default:
      return String(card.value);
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ─── Status badge ──────────────────────────────────────────────────

function StatusDot({ status }: { status: HealthStatus | "neutral" }) {
  const cls =
    status === "green"
      ? "bg-emerald-500"
      : status === "amber"
      ? "bg-amber-500"
      : status === "red"
      ? "bg-rose-500"
      : "bg-slate-400";
  const pulsing = status === "red";
  return (
    <span className="relative inline-flex h-2 w-2" aria-hidden>
      {pulsing ? (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${cls}`}
        />
      ) : null}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${cls}`} />
    </span>
  );
}

const HEALTH_RAIL: Record<HealthStatus | "neutral", string> = {
  green: "before:bg-emerald-400/55",
  amber: "before:bg-amber-400/70",
  red: "before:bg-rose-500/80",
  neutral: "before:bg-slate-300/55",
};

// ─── Section A — Infrastructure grid ───────────────────────────────

function InfraCard({ card, onOpen }: { card: HealthCard; onOpen: (c: HealthCard) => void }) {
  const ring =
    card.status === "red"
      ? "border-rose-200 bg-gradient-to-br from-white to-rose-50/40 shadow-[0_0_0_1px_rgba(244,63,94,0.06)]"
      : card.status === "amber"
      ? "border-amber-200 bg-gradient-to-br from-white to-amber-50/40"
      : "border-slate-200 bg-gradient-to-br from-white to-slate-50/30";
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      className={`group relative overflow-hidden rounded-2xl border p-3.5 pl-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)] before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${HEALTH_RAIL[card.status]} ${ring}`}
      title={card.tooltip}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          <StatusDot status={card.status} />
          <span>{card.label}</span>
        </div>
        <ChevronRight className="h-3 w-3 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div
        className="mt-1.5 text-[22px] font-semibold leading-none text-slate-900"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {fmt(card)}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="truncate" title={card.detail}>
          {card.error ? (
            <span className="text-rose-700">err: {card.error.slice(0, 40)}</span>
          ) : (
            card.detail
          )}
        </span>
        <span className="whitespace-nowrap text-[10px] text-slate-400">{timeAgo(card.lastUpdatedAt)}</span>
      </div>
    </button>
  );
}

function InfraGrid({
  data,
  onOpen,
}: {
  data: InfrastructureHealth | null;
  onOpen: (c: HealthCard) => void;
}) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 15 }).map((_, i) => (
          <div key={i} className="h-[88px] animate-pulse rounded-2xl border border-slate-200 bg-slate-50/50" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {data.cards.map((c) => (
        <InfraCard key={c.key} card={c} onOpen={onOpen} />
      ))}
    </div>
  );
}

// ─── Section B — Integration matrix ────────────────────────────────

const PROVIDER_ICONS: Record<string, React.ReactNode> = {
  google: <CalendarSync className="h-4 w-4" />,
  microsoft: <CalendarSync className="h-4 w-4" />,
  zoom: <CalendarSync className="h-4 w-4" />,
  stripe: <Activity className="h-4 w-4" />,
  ses: <Mail className="h-4 w-4" />,
};

function ProviderRow({
  p,
  onDrilldown,
}: {
  p: IntegrationProvider;
  onDrilldown: (p: IntegrationProvider) => void;
}) {
  const statusCls =
    p.status === "healthy"
      ? "text-emerald-700 bg-emerald-50"
      : p.status === "degraded"
      ? "text-amber-700 bg-amber-50"
      : p.status === "critical"
      ? "text-rose-700 bg-rose-50"
      : "text-slate-600 bg-slate-100";
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50/60">
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="text-slate-500">{PROVIDER_ICONS[p.key] ?? <Activity className="h-4 w-4" />}</span>
          <div>
            <div className="text-sm font-medium text-slate-900">{p.label}</div>
            <div className="text-[11px] text-slate-500">{p.detail}</div>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-right">
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusCls}`}>
          {p.status}
        </span>
      </td>
      <td className="px-3 py-3 text-right text-sm tabular-nums">{p.connectedTenants}</td>
      <td className="px-3 py-3 text-right text-sm tabular-nums text-emerald-700">{p.activeTokens}</td>
      <td className="px-3 py-3 text-right text-sm tabular-nums">
        {p.expiredTokens > 0 ? <span className="text-rose-700">{p.expiredTokens}</span> : <span className="text-slate-400">0</span>}
      </td>
      <td className="px-3 py-3 text-right text-sm tabular-nums">{p.refreshFailures}</td>
      <td className="px-3 py-3 text-right text-sm tabular-nums">{p.webhookFailures}</td>
      <td className="px-3 py-3 text-right text-sm tabular-nums">
        {p.apiErrorRate === null ? <span className="text-slate-400">—</span> : `${p.apiErrorRate}%`}
      </td>
      <td className="px-3 py-3 text-right">
        {p.affectedTenantIds.length > 0 ? (
          <button
            type="button"
            onClick={() => onDrilldown(p)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
          >
            {p.affectedTenantIds.length} affected <ChevronRight className="h-3 w-3" />
          </button>
        ) : (
          <span className="text-[11px] text-slate-400">—</span>
        )}
      </td>
    </tr>
  );
}

function IntegrationMatrix({
  data,
  onDrilldown,
}: {
  data: IntegrationsMatrix | null;
  onDrilldown: (p: IntegrationProvider) => void;
}) {
  if (!data) {
    return <div className="h-[280px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <table className="w-full">
        <thead>
          <tr className="bg-slate-50 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
            <th className="px-3 py-2.5">Provider</th>
            <th className="px-3 py-2.5 text-right">Status</th>
            <th className="px-3 py-2.5 text-right">Tenants</th>
            <th className="px-3 py-2.5 text-right">Active</th>
            <th className="px-3 py-2.5 text-right">Expired</th>
            <th className="px-3 py-2.5 text-right">Refresh fails</th>
            <th className="px-3 py-2.5 text-right">Webhook fails</th>
            <th className="px-3 py-2.5 text-right">Err rate</th>
            <th className="px-3 py-2.5 text-right">Drilldown</th>
          </tr>
        </thead>
        <tbody>
          {data.providers.map((p) => (
            <ProviderRow key={p.key} p={p} onDrilldown={onDrilldown} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Section C — Comms monitoring ──────────────────────────────────

function CommsTileCard({ tile }: { tile: CommsTile }) {
  const valueStr =
    tile.value === null ? "—" : tile.unit === "percent" ? `${tile.value}%` : new Intl.NumberFormat("en-US").format(Number(tile.value));
  const ring =
    tile.status === "red"
      ? "border-rose-200 bg-gradient-to-br from-white to-rose-50/40 shadow-[0_0_0_1px_rgba(244,63,94,0.06)]"
      : tile.status === "amber"
      ? "border-amber-200 bg-gradient-to-br from-white to-amber-50/40"
      : tile.status === "green"
      ? "border-emerald-200 bg-gradient-to-br from-white to-emerald-50/30"
      : "border-slate-200 bg-gradient-to-br from-white to-slate-50/30";
  return (
    <div
      className={`group relative overflow-hidden rounded-2xl border p-3.5 pl-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)] before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${HEALTH_RAIL[tile.status]} ${ring}`}
      title={tile.tooltip}
    >
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        <StatusDot status={tile.status} />
        <span>{tile.label}</span>
      </div>
      <div
        className="mt-1.5 text-[22px] font-semibold leading-none text-slate-900"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {valueStr}
      </div>
      <div className="mt-2 truncate text-[11px] text-slate-500">{tile.detail}</div>
    </div>
  );
}

function CommsSection({ data }: { data: CommsMonitoring | null }) {
  if (!data) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-[88px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
          ))}
        </div>
        <div className="h-[240px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
      </div>
    );
  }
  const allZero = data.hourly.every((p) => p.sent === 0 && p.failed === 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {data.tiles.map((t) => (
          <CommsTileCard key={t.key} tile={t} />
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="mb-3 flex items-end justify-between">
          <div>
            <h3 className="text-sm font-medium text-slate-900">Outgoing notifications · last 24h</h3>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Hourly buckets from communication_logs
            </p>
          </div>
        </div>
        {allZero ? (
          <div className="flex h-[180px] items-center justify-center rounded-md border border-dashed border-slate-200 text-center text-sm text-slate-500">
            No communication activity in the last 24 hours.
          </div>
        ) : (
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.hourly} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="hour" tick={{ fontSize: 10, fill: "#64748b" }} interval={2} />
                <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={32} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0", fontSize: 12 }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 11, color: "#475569" }} />
                <Line type="monotone" dataKey="sent" name="Sent" stroke="#10b981" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="failed" name="Failed" stroke="#ef4444" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section D — Live activity feed ────────────────────────────────

const SEVERITY_CLS: Record<string, string> = {
  info: "bg-sky-50 text-sky-700",
  warning: "bg-amber-50 text-amber-700",
  critical: "bg-rose-50 text-rose-700",
};

const KIND_LABELS: Record<string, string> = {
  failed_webhook: "Webhook failed",
  stripe_error: "Stripe error",
  oauth_failure: "OAuth failure",
  sync_failure: "Calendar sync",
  cron_failure: "Cron failure",
  queue_spike: "Queue spike",
  suspicious_activity: "Suspicious activity",
  ses_bounce: "SES event",
  new_signup: "New signup",
  new_subscription: "New subscription",
  subscription_cancel: "Cancelled",
  payment_failed: "Payment failed",
};

const ALL_KINDS = Object.keys(KIND_LABELS);

function FeedRow({ e }: { e: ActivityEvent }) {
  const sev = SEVERITY_CLS[e.severity] ?? SEVERITY_CLS.info;
  return (
    <div className="flex items-start gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-slate-50/40">
      <span className={`mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${sev}`}>
        {e.severity}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-slate-900">{e.summary}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
          <span>{KIND_LABELS[e.kind] ?? e.kind}</span>
          <span>·</span>
          <span>{timeAgo(e.ts)}</span>
          {e.tenantId ? (
            <>
              <span>·</span>
              <a href={`/admin/tenants/${e.tenantId}`} className="hover:text-slate-700 hover:underline">
                tenant {e.tenantId.slice(0, 8)}
              </a>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ActivityFeed({ initial }: { initial: ActivityPage | null }) {
  const [events, setEvents] = React.useState<ActivityEvent[]>(initial?.events ?? []);
  const [cursor, setCursor] = React.useState<string | null>(initial?.nextCursor ?? null);
  const [selectedKinds, setSelectedKinds] = React.useState<string[]>([]);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [showFilter, setShowFilter] = React.useState(false);

  // Re-fetch top-of-stream on filter change.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (selectedKinds.length > 0) params.set("kinds", selectedKinds.join(","));
        const res = await fetch(`/api/admin/system-health/feed?${params.toString()}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const page = (await res.json()) as ActivityPage;
        if (cancelled) return;
        setEvents(page.events);
        setCursor(page.nextCursor);
      } catch {
        // Soft fail — keep prior events.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedKinds]);

  // Poll for new events every 30s — prepend any newer than the
  // current top row.
  React.useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        if (document.hidden) return;
        const params = new URLSearchParams({ limit: "20" });
        if (selectedKinds.length > 0) params.set("kinds", selectedKinds.join(","));
        const res = await fetch(`/api/admin/system-health/feed?${params.toString()}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const page = (await res.json()) as ActivityPage;
        if (cancelled) return;
        setEvents((prev) => {
          if (prev.length === 0) return page.events;
          const topTs = prev[0].ts;
          const fresh = page.events.filter((e) => e.ts > topTs);
          return fresh.length > 0 ? [...fresh, ...prev] : prev;
        });
      } catch {}
    };
    const id = window.setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedKinds]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: "50", cursor });
      if (selectedKinds.length > 0) params.set("kinds", selectedKinds.join(","));
      const res = await fetch(`/api/admin/system-health/feed?${params.toString()}`, { cache: "no-store" });
      if (res.ok) {
        const page = (await res.json()) as ActivityPage;
        setEvents((prev) => [...prev, ...page.events]);
        setCursor(page.nextCursor);
      }
    } finally {
      setLoadingMore(false);
    }
  }

  function toggleKind(k: string) {
    setSelectedKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Activity className="h-3.5 w-3.5 text-slate-500" />
          Live activity feed
          {events.length > 0 ? <span className="text-[11px] text-slate-500">· {events.length} loaded</span> : null}
        </div>
        <button
          type="button"
          onClick={() => setShowFilter((s) => !s)}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
        >
          <Filter className="h-3 w-3" />
          Filter
          {selectedKinds.length > 0 ? <span className="ml-1 rounded-full bg-slate-900 px-1.5 text-[10px] text-white">{selectedKinds.length}</span> : null}
        </button>
      </div>
      {showFilter ? (
        <div className="flex flex-wrap gap-1.5 border-b border-slate-100 px-4 py-3">
          {ALL_KINDS.map((k) => {
            const active = selectedKinds.includes(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleKind(k)}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                }`}
              >
                {KIND_LABELS[k]}
              </button>
            );
          })}
          {selectedKinds.length > 0 ? (
            <button
              type="button"
              onClick={() => setSelectedKinds([])}
              className="rounded-full px-2 py-0.5 text-[11px] text-slate-500 hover:text-slate-700 hover:underline"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="max-h-[520px] overflow-y-auto">
        {events.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">No recent operational events.</div>
        ) : (
          events.map((e) => <FeedRow key={e.id} e={e} />)
        )}
      </div>

      {cursor ? (
        <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-2.5 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3 w-3" />}
            Load more
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ─── Infrastructure card drilldown drawer ─────────────────────────

const STATUS_TONE: Record<
  HealthStatus,
  { chip: string; headerGradient: string; label: string }
> = {
  green: { chip: "bg-emerald-50 text-emerald-700 ring-emerald-200", headerGradient: "from-emerald-50/40 via-white to-white", label: "Healthy" },
  amber: { chip: "bg-amber-50 text-amber-700 ring-amber-200", headerGradient: "from-amber-50/50 via-white to-white", label: "Degraded" },
  red: { chip: "bg-rose-50 text-rose-700 ring-rose-200", headerGradient: "from-rose-50/60 via-white to-white", label: "Critical" },
};

function InfraCardDrawer({
  card,
  onClose,
}: {
  card: HealthCard | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!card) return null;
  const tone = STATUS_TONE[card.status];

  // Sparkline (if present)
  const sparkline = card.sparkline ?? [];
  const w = 320;
  const h = 60;
  const max = Math.max(...sparkline, 1);
  const step = sparkline.length > 1 ? w / (sparkline.length - 1) : w;
  const points = sparkline
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`)
    .join(" ");

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/30 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl animate-[slideInDrawer_220ms_ease-out]"
        onClick={(e) => e.stopPropagation()}
      >
        <header
          className={`sticky top-0 z-10 border-b border-slate-200 bg-gradient-to-br ${tone.headerGradient} px-6 py-5`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${tone.chip}`}
                >
                  <StatusDot status={card.status} />
                  {tone.label}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-700">
                  Infra
                </span>
              </div>
              <h2 className="mt-2 text-base font-semibold tracking-tight text-slate-900">
                {card.label}
              </h2>
              <div className="mt-1 text-[12px] text-slate-500">
                Last updated {timeAgo(card.lastUpdatedAt)}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="space-y-5 px-6 py-5">
          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Current value
            </div>
            <div
              className="text-[32px] font-semibold leading-none text-slate-900"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {fmt(card)}
            </div>
            <div className="mt-1 text-[12px] text-slate-600">{card.detail}</div>
          </section>

          {sparkline.length > 1 ? (
            <section>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                Recent trend
              </div>
              <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50/30 to-white p-3">
                <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
                  <polyline
                    points={points}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.75}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    className={
                      card.status === "red"
                        ? "text-rose-500"
                        : card.status === "amber"
                        ? "text-amber-500"
                        : "text-emerald-500"
                    }
                  />
                </svg>
                <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-slate-400">
                  <span>{Math.min(...sparkline)}</span>
                  <span>peak {max}</span>
                </div>
              </div>
            </section>
          ) : null}

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Threshold context
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <dt className="text-slate-500">Amber at</dt>
              <dd className="font-medium text-slate-800 tabular-nums">
                {card.thresholds.amber !== null ? String(card.thresholds.amber) : "—"}
              </dd>
              <dt className="text-slate-500">Red at</dt>
              <dd className="font-medium text-slate-800 tabular-nums">
                {card.thresholds.red !== null ? String(card.thresholds.red) : "—"}
              </dd>
              <dt className="text-slate-500">Unit</dt>
              <dd className="font-medium text-slate-800">{card.unit}</dd>
              <dt className="text-slate-500">Key</dt>
              <dd className="break-all font-mono text-[11px] text-slate-800">{card.key}</dd>
            </dl>
          </section>

          {card.error ? (
            <section>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                Last error
              </div>
              <pre className="overflow-auto rounded-lg border border-rose-200 bg-rose-50/30 p-3 text-[11px] leading-relaxed text-rose-800">
                {card.error}
              </pre>
            </section>
          ) : null}

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              About this signal
            </div>
            <p className="text-[12px] leading-relaxed text-slate-700">{card.tooltip}</p>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Quick actions
            </div>
            <div className="grid grid-cols-2 gap-2">
              <a
                href="/admin/ops"
                className="group inline-flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-700 hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-[0_4px_12px_rgba(15,23,42,0.05)] transition-all"
              >
                <span className="inline-flex items-center gap-2">
                  <Activity className="h-3 w-3 text-slate-400" />
                  Open ops
                </span>
                <ChevronRight className="h-3 w-3 text-slate-300" />
              </a>
              <a
                href="/admin/diagnostics"
                className="group inline-flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-700 hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-[0_4px_12px_rgba(15,23,42,0.05)] transition-all"
              >
                <span className="inline-flex items-center gap-2">
                  <Shield className="h-3 w-3 text-slate-400" />
                  Open diagnostics
                </span>
                <ChevronRight className="h-3 w-3 text-slate-300" />
              </a>
              <a
                href="/admin/activity"
                className="group inline-flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-700 hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-[0_4px_12px_rgba(15,23,42,0.05)] transition-all"
              >
                <span className="inline-flex items-center gap-2">
                  <Clock className="h-3 w-3 text-slate-400" />
                  Open activity
                </span>
                <ChevronRight className="h-3 w-3 text-slate-300" />
              </a>
              <a
                href="/admin/security"
                className="group inline-flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-700 hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-[0_4px_12px_rgba(15,23,42,0.05)] transition-all"
              >
                <span className="inline-flex items-center gap-2">
                  <Shield className="h-3 w-3 text-slate-400" />
                  Open security
                </span>
                <ChevronRight className="h-3 w-3 text-slate-300" />
              </a>
            </div>
            <p className="mt-3 text-[11px] italic text-slate-500">
              Read-only diagnostics — no autonomous remediation.
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}

// ─── Drilldown modal ───────────────────────────────────────────────

function DrilldownModal({
  provider,
  onClose,
}: {
  provider: IntegrationProvider | null;
  onClose: () => void;
}) {
  if (!provider) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{provider.label} drilldown</h3>
            <p className="mt-0.5 text-[12px] text-slate-500">{provider.detail}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            ✕
          </button>
        </div>
        {provider.affectedTenantIds.length === 0 ? (
          <div className="mt-4 rounded-md border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500">
            No affected tenants right now.
          </div>
        ) : (
          <div className="mt-4 max-h-[320px] overflow-y-auto">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">
              {provider.affectedTenantIds.length} affected tenant{provider.affectedTenantIds.length === 1 ? "" : "s"}
            </div>
            <ul className="space-y-1.5">
              {provider.affectedTenantIds.map((id) => (
                <li key={id}>
                  <a
                    href={`/admin/tenants/${id}`}
                    className="block truncate rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                  >
                    {id}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Top-level client ──────────────────────────────────────────────

type Initial = {
  infra: InfrastructureHealth | null;
  integrations: IntegrationsMatrix | null;
  comms: CommsMonitoring | null;
  feed: ActivityPage | null;
};

export default function SystemHealthClient({ initial }: { initial: Initial }) {
  const [infra, setInfra] = React.useState<InfrastructureHealth | null>(initial.infra);
  const [integrations, setIntegrations] = React.useState<IntegrationsMatrix | null>(initial.integrations);
  const [comms, setComms] = React.useState<CommsMonitoring | null>(initial.comms);
  const [drilldown, setDrilldown] = React.useState<IntegrationProvider | null>(null);
  const [infraDrawer, setInfraDrawer] = React.useState<HealthCard | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());
  const [refreshing, setRefreshing] = React.useState(false);
  const [heartbeatTick, setHeartbeatTick] = React.useState(0);

  const refreshAll = React.useCallback(async () => {
    if (document.hidden) return;
    setRefreshing(true);
    try {
      const [a, b, c] = await Promise.all([
        fetch("/api/admin/system-health/infra", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/admin/system-health/integrations", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        fetch("/api/admin/system-health/comms", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      ]);
      if (a) setInfra(a);
      if (b) setIntegrations(b);
      if (c) setComms(c);
      setLastRefreshAt(Date.now());
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(refreshAll, 60_000);
    const onVis = () => {
      if (!document.hidden && Date.now() - lastRefreshAt > 30_000) {
        void refreshAll();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refreshAll, lastRefreshAt]);

  React.useEffect(() => {
    const id = window.setInterval(() => setHeartbeatTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Derive mission KPIs + insights — DETERMINISTIC, client-side.
  const mission = deriveHealthMission({ infra, integrations, comms });
  const insights = deriveHealthInsights({ infra, integrations, comms, kpis: mission });

  const infraInsight = insights.find((i) => i.surface === "infra") ?? null;
  const integrationsInsight = insights.find((i) => i.surface === "integrations") ?? null;
  const commsInsight = insights.find((i) => i.surface === "comms") ?? null;

  return (
    <div className="space-y-6">
      <style jsx global>{`
        @keyframes slideInDrawer {
          from {
            transform: translateX(20px);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>

      {/* Sticky executive header with heartbeat */}
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-2xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <span className="relative inline-flex h-2 w-2">
            <span
              key={heartbeatTick}
              className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-75"
            />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          <div>
            <div className="text-[13px] font-semibold tracking-tight text-slate-900">
              Platform Health Center
            </div>
            <div className="text-[11px] text-slate-500">
              Continuously monitored · auto-refresh 60s · last {timeAgo(new Date(lastRefreshAt).toISOString())}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void refreshAll()}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Mission hero */}
      <HealthMissionHero kpis={mission} insights={insights} liveOn={!refreshing} />

      {/* Section A — Infrastructure */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Database className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">Infrastructure</h2>
          {infra ? (
            <span className="text-[11px] text-slate-400">computed in {infra.computedInMs}ms</span>
          ) : null}
          {infraInsight ? (
            <div className="ml-2">
              <HealthInsightChip insight={infraInsight} />
            </div>
          ) : null}
        </div>
        <InfraGrid data={infra} onOpen={setInfraDrawer} />
      </section>

      {/* Section B — Integrations */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <CalendarSync className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">Integrations</h2>
          {integrations ? (
            <span className="text-[11px] text-slate-400">computed in {integrations.computedInMs}ms</span>
          ) : null}
          {integrationsInsight ? (
            <div className="ml-2">
              <HealthInsightChip insight={integrationsInsight} />
            </div>
          ) : null}
        </div>
        <IntegrationMatrix data={integrations} onDrilldown={setDrilldown} />
      </section>

      {/* Section C — Communications */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Mail className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">Communications</h2>
          {comms ? <span className="text-[11px] text-slate-400">computed in {comms.computedInMs}ms</span> : null}
          {commsInsight ? (
            <div className="ml-2">
              <HealthInsightChip insight={commsInsight} />
            </div>
          ) : null}
        </div>
        <CommsSection data={comms} />
      </section>

      {/* Section D — Live feed */}
      <section>
        <div className="mb-3 flex flex-wrap items-baseline gap-2">
          <Activity className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">Live operational feed</h2>
        </div>
        <ActivityFeed initial={initial.feed} />
      </section>

      <DrilldownModal provider={drilldown} onClose={() => setDrilldown(null)} />
      <InfraCardDrawer card={infraDrawer} onClose={() => setInfraDrawer(null)} />
    </div>
  );
}
