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
  const pulse = status === "red" ? "animate-pulse" : "";
  return (
    <span className={`inline-flex h-2 w-2 rounded-full ${cls} ${pulse}`} aria-hidden />
  );
}

// ─── Section A — Infrastructure grid ───────────────────────────────

function InfraCard({ card }: { card: HealthCard }) {
  const ring =
    card.status === "red"
      ? "border-rose-200 bg-rose-50/30"
      : card.status === "amber"
      ? "border-amber-200 bg-amber-50/30"
      : "border-slate-200 bg-white";
  return (
    <div
      className={`rounded-xl border p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)] ${ring}`}
      title={card.tooltip}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
          <StatusDot status={card.status} />
          <span>{card.label}</span>
        </div>
      </div>
      <div className="mt-1.5 text-[20px] font-semibold leading-none text-slate-900">{fmt(card)}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="truncate" title={card.detail}>
          {card.error ? <span className="text-rose-700">err: {card.error.slice(0, 40)}</span> : card.detail}
        </span>
        <span className="whitespace-nowrap text-[10px] text-slate-400">{timeAgo(card.lastUpdatedAt)}</span>
      </div>
    </div>
  );
}

function InfraGrid({ data }: { data: InfrastructureHealth | null }) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 15 }).map((_, i) => (
          <div key={i} className="h-[88px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {data.cards.map((c) => (
        <InfraCard key={c.key} card={c} />
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
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]" title={tile.tooltip}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
        <StatusDot status={tile.status} />
        <span>{tile.label}</span>
      </div>
      <div className="mt-1.5 text-[20px] font-semibold leading-none text-slate-900">{valueStr}</div>
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
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());
  const [refreshing, setRefreshing] = React.useState(false);

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

  return (
    <div className="space-y-6">
      {/* Sticky executive header */}
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Platform Health Center</div>
            <div className="text-[11px] text-slate-500">
              Auto-refreshes every 60s · last refresh {timeAgo(new Date(lastRefreshAt).toISOString())}
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

      {/* Section A — Infrastructure */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Infrastructure</h2>
          {infra ? (
            <span className="text-[11px] text-slate-400">{infra.computedInMs}ms</span>
          ) : null}
        </div>
        <InfraGrid data={infra} />
      </section>

      {/* Section B — Integrations */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <CalendarSync className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Integrations</h2>
          {integrations ? (
            <span className="text-[11px] text-slate-400">{integrations.computedInMs}ms</span>
          ) : null}
        </div>
        <IntegrationMatrix data={integrations} onDrilldown={setDrilldown} />
      </section>

      {/* Section C — Communications */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Communications</h2>
          {comms ? <span className="text-[11px] text-slate-400">{comms.computedInMs}ms</span> : null}
        </div>
        <CommsSection data={comms} />
      </section>

      {/* Section D — Live feed */}
      <section>
        <ActivityFeed initial={initial.feed} />
      </section>

      <DrilldownModal provider={drilldown} onClose={() => setDrilldown(null)} />
    </div>
  );
}
