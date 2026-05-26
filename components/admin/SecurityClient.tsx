"use client";

/**
 * SA-7 — Security & Audit Operations Center.
 *
 * Five sections in one client:
 *   §A KPI grid (11 cards, auto-refresh 60s)
 *   §B Audit explorer (search + filter + paginate + CSV)
 *   §C Security event feed (reuses /api/admin/activity/feed with
 *      security-only kinds — already shipped in SA-5)
 *   §D IP Intelligence (3 tables)
 *   §E Permission tracking
 */

import * as React from "react";
import {
  AlertTriangle,
  ChevronRight,
  Clock,
  Download,
  Filter,
  Globe,
  Key,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

import type { SecurityKpiBundle, SecurityKpiCard, IpIntelligence, AuditPage, AuditRow, PermissionEvent } from "@/lib/admin-analytics/security";

type Initial = {
  kpis: SecurityKpiBundle | null;
  ipIntel: IpIntelligence | null;
  audit: AuditPage | null;
  permissions: { events: PermissionEvent[]; nextCursor: string | null } | null;
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

const STATUS_RING: Record<SecurityKpiCard["status"], string> = {
  green: "border-slate-200 bg-white",
  amber: "border-amber-200 bg-amber-50/30",
  red: "border-rose-200 bg-rose-50/30",
};

// ─── §A KPI grid ────────────────────────────────────────────────────

function StatusDot({ status }: { status: SecurityKpiCard["status"] }) {
  const cls =
    status === "green" ? "bg-emerald-500" : status === "amber" ? "bg-amber-500" : "bg-rose-500";
  const pulse = status === "red" ? "animate-pulse" : "";
  return <span className={`inline-flex h-2 w-2 rounded-full ${cls} ${pulse}`} aria-hidden />;
}

function KpiCard({ card }: { card: SecurityKpiCard }) {
  const value =
    card.value === null
      ? "—"
      : card.unit === "percent"
      ? `${card.value}%`
      : new Intl.NumberFormat("en-US").format(Number(card.value));
  return (
    <div
      className={`rounded-xl border p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)] ${STATUS_RING[card.status]}`}
      title={card.tooltip}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-500">
        <StatusDot status={card.status} />
        <span>{card.label}</span>
      </div>
      <div className="mt-1.5 text-[20px] font-semibold leading-none text-slate-900">{value}</div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
        <span className="truncate">
          {card.error ? <span className="text-rose-700">err: {card.error.slice(0, 40)}</span> : card.detail}
        </span>
        {card.trendPct !== null ? (
          <span
            className={`whitespace-nowrap font-medium ${
              card.trendPct > 0 ? "text-rose-700" : card.trendPct < 0 ? "text-emerald-700" : "text-slate-500"
            }`}
          >
            {card.trendPct > 0 ? "+" : ""}
            {card.trendPct}%
          </span>
        ) : null}
      </div>
    </div>
  );
}

function KpiGrid({ data }: { data: SecurityKpiBundle | null }) {
  if (!data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 11 }).map((_, i) => (
          <div key={i} className="h-[88px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
      {data.cards.map((c) => (
        <KpiCard key={c.key} card={c} />
      ))}
    </div>
  );
}

// ─── §D IP Intelligence ─────────────────────────────────────────────

function IpIntelSection({ data }: { data: IpIntelligence | null }) {
  if (!data) {
    return <div className="h-[240px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />;
  }
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      <IpTable
        title="Top suspicious IPs"
        subtitle="≥5 failed logins in last 24h"
        icon={<ShieldAlert className="h-3.5 w-3.5 text-rose-600" />}
        emptyText="No suspicious IPs in last 24h."
        rows={data.topSuspiciousIps}
        columns={[
          { label: "IP", get: (r) => <span className="font-mono text-[12px]">{r.ip}</span> },
          { label: "Failed", get: (r) => <span className="font-medium text-rose-700">{r.failedLogins24h}</span>, align: "right" },
          { label: "Actors", get: (r) => r.actorCount, align: "right" },
          { label: "Last", get: (r) => <span className="text-[11px] text-slate-500">{timeAgo(r.lastSeen)}</span> },
        ]}
      />
      <IpTable
        title="Multi-IP actors"
        subtitle="Users hitting ≥3 distinct IPs in last 24h"
        icon={<Globe className="h-3.5 w-3.5 text-amber-600" />}
        emptyText="No multi-IP actors in last 24h."
        rows={data.multiIpActors}
        columns={[
          { label: "Actor", get: (r) => <span className="truncate text-[12px]">{r.actor}</span> },
          { label: "IPs", get: (r) => <span className="font-medium text-amber-700">{r.distinctIps}</span>, align: "right" },
          { label: "Events", get: (r) => r.eventCount24h, align: "right" },
        ]}
      />
      <IpTable
        title="Admin access locations"
        subtitle="Admin/permission/impersonation events by IP (7d)"
        icon={<Lock className="h-3.5 w-3.5 text-slate-600" />}
        emptyText="No admin activity recorded in last 7d."
        rows={data.adminAccessLocations}
        columns={[
          { label: "IP", get: (r) => <span className="font-mono text-[12px]">{r.ip}</span> },
          { label: "Actor", get: (r) => <span className="truncate text-[12px]">{r.actor ?? "—"}</span> },
          { label: "Actions", get: (r) => r.actionCount, align: "right" },
        ]}
      />
    </div>
  );
}

function IpTable<T>({
  title,
  subtitle,
  icon,
  emptyText,
  rows,
  columns,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  emptyText: string;
  rows: T[];
  columns: Array<{ label: string; get: (row: T) => React.ReactNode; align?: "left" | "right" }>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
          {icon}
          {title}
        </div>
        <div className="text-[11px] text-slate-500">{subtitle}</div>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-10 text-center text-[12px] text-slate-500">{emptyText}</div>
      ) : (
        <table className="w-full">
          <thead className="bg-slate-50/40 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
            <tr>
              {columns.map((c) => (
                <th key={c.label} className={`px-3 py-1.5 ${c.align === "right" ? "text-right" : ""}`}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/40">
                {columns.map((c) => (
                  <td key={c.label} className={`px-3 py-2 ${c.align === "right" ? "text-right" : ""}`}>
                    {c.get(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── §B Audit Explorer ──────────────────────────────────────────────

function AuditExplorer({ initial }: { initial: AuditPage | null }) {
  const [rows, setRows] = React.useState<AuditRow[]>(initial?.rows ?? []);
  const [cursor, setCursor] = React.useState<string | null>(initial?.nextCursor ?? null);
  const [search, setSearch] = React.useState("");
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  const [actor, setActor] = React.useState("");
  const [tenantId, setTenantId] = React.useState("");
  const [ip, setIp] = React.useState("");
  const [rangeIdx, setRangeIdx] = React.useState(2);
  const [loading, setLoading] = React.useState(false);
  const [drawer, setDrawer] = React.useState<AuditRow | null>(null);

  React.useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const presets = [
    { label: "Last 1h", ms: 60 * 60_000 },
    { label: "Last 24h", ms: 24 * 60 * 60_000 },
    { label: "Last 7d", ms: 7 * 24 * 60 * 60_000 },
    { label: "Last 30d", ms: 30 * 24 * 60 * 60_000 },
    { label: "All time", ms: null as number | null },
  ];

  const buildSp = React.useCallback(
    (limit: number, opts?: { cursor?: string | null }) => {
      const sp = new URLSearchParams({ limit: String(limit) });
      if (debouncedSearch) sp.set("action", debouncedSearch);
      if (actor) sp.set("actor", actor);
      if (tenantId.trim()) sp.set("tenantId", tenantId.trim());
      if (ip) sp.set("ip", ip);
      const ms = presets[rangeIdx].ms;
      if (ms !== null) sp.set("since", new Date(Date.now() - ms).toISOString());
      if (opts?.cursor) sp.set("cursor", opts.cursor);
      return sp;
    },
    [debouncedSearch, actor, tenantId, ip, rangeIdx, presets],
  );

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/admin/security/audit?${buildSp(50).toString()}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const page = (await res.json()) as AuditPage;
        if (cancelled) return;
        setRows(page.rows);
        setCursor(page.nextCursor);
      } catch {
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildSp]);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/security/audit?${buildSp(50, { cursor }).toString()}`, { cache: "no-store" });
      if (res.ok) {
        const page = (await res.json()) as AuditPage;
        setRows((prev) => [...prev, ...page.rows]);
        setCursor(page.nextCursor);
      }
    } finally {
      setLoading(false);
    }
  }

  function csvHref() {
    const sp = buildSp(2000);
    sp.set("format", "csv");
    return `/api/admin/security/audit?${sp.toString()}`;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search action…"
            className="w-56 rounded-md border border-slate-200 bg-white py-1.5 pl-7 pr-3 text-[13px] placeholder:text-slate-400 focus:border-slate-400 focus:outline-none"
          />
        </div>
        <input
          type="text"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Actor…"
          className="w-40 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        />
        <input
          type="text"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          placeholder="Tenant ID…"
          className="w-40 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        />
        <input
          type="text"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          placeholder="IP…"
          className="w-32 rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        />
        <select
          value={rangeIdx}
          onChange={(e) => setRangeIdx(Number(e.target.value))}
          className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px]"
        >
          {presets.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={csvHref()}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3 w-3" />
            CSV
          </a>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" /> : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <table className="w-full">
          <thead className="bg-slate-50 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Tenant</th>
              <th className="px-3 py-2">IP</th>
              <th className="px-3 py-2">Entity</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-sm text-slate-500">
                  No audit rows match your filters.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setDrawer(r)}
                  className="cursor-pointer border-t border-slate-100 text-[12px] hover:bg-slate-50/60"
                >
                  <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{new Date(r.ts).toLocaleString()}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-800">{r.action}</td>
                  <td className="px-3 py-2 text-slate-700">{r.actor ?? "—"}</td>
                  <td className="px-3 py-2">
                    {r.tenantId ? (
                      <a
                        href={`/admin/tenants/${r.tenantId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="font-mono text-[11px] text-sky-700 hover:underline"
                      >
                        {r.tenantId.slice(0, 8)}
                      </a>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-600">{r.ipAddress ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.entityType ? `${r.entityType}${r.entityId ? "·" + r.entityId.slice(0, 6) : ""}` : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {cursor ? (
          <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-2 text-center">
            <button
              type="button"
              onClick={loadMore}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3 w-3" />}
              Load more
            </button>
          </div>
        ) : null}
      </div>

      {drawer ? <AuditDrawer row={drawer} onClose={() => setDrawer(null)} /> : null}
    </div>
  );
}

function AuditDrawer({ row, onClose }: { row: AuditRow; onClose: () => void }) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={onClose}>
      <aside
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <div className="font-mono text-[11px] text-slate-500">{row.action}</div>
            <div className="mt-0.5 text-[13px] text-slate-700">{new Date(row.ts).toLocaleString()}</div>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="space-y-4 px-6 py-5 text-[13px]">
          <Field label="Actor" value={row.actor ?? <span className="text-slate-400">—</span>} />
          <Field
            label="Tenant"
            value={
              row.tenantId ? (
                <a href={`/admin/tenants/${row.tenantId}`} className="font-mono text-sky-700 hover:underline">
                  {row.tenantId}
                </a>
              ) : (
                <span className="text-slate-400">—</span>
              )
            }
          />
          <Field
            label="IP"
            value={
              row.ipAddress ? (
                <span className="font-mono">{row.ipAddress}</span>
              ) : (
                <span className="text-slate-400">—</span>
              )
            }
          />
          <Field
            label="Entity"
            value={
              row.entityType ? (
                <span className="font-mono">
                  {row.entityType}
                  {row.entityId ? ` · ${row.entityId}` : ""}
                </span>
              ) : (
                <span className="text-slate-400">—</span>
              )
            }
          />
          {row.metadata && Object.keys(row.metadata).length > 0 ? (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Metadata</div>
              <pre className="mt-1 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700">
                {JSON.stringify(row.metadata, null, 2)}
              </pre>
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-3 border-b border-slate-100 pb-2">
      <div className="text-slate-500">{label}</div>
      <div className="col-span-2 break-words">{value}</div>
    </div>
  );
}

// ─── §E Permission events ───────────────────────────────────────────

const CATEGORY_STYLES: Record<PermissionEvent["category"], string> = {
  role_change: "bg-sky-50 text-sky-700",
  permission_grant: "bg-violet-50 text-violet-700",
  impersonation: "bg-slate-100 text-slate-700",
  bulk_admin: "bg-amber-50 text-amber-700",
  financial: "bg-emerald-50 text-emerald-700",
  manual_override: "bg-rose-50 text-rose-700",
};

function PermissionFeed({ initial }: { initial: { events: PermissionEvent[]; nextCursor: string | null } | null }) {
  const [events, setEvents] = React.useState<PermissionEvent[]>(initial?.events ?? []);
  const [cursor, setCursor] = React.useState<string | null>(initial?.nextCursor ?? null);
  const [loading, setLoading] = React.useState(false);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/security/permissions?limit=50&cursor=${encodeURIComponent(cursor)}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const page = (await res.json()) as { events: PermissionEvent[]; nextCursor: string | null };
        setEvents((prev) => [...prev, ...page.events]);
        setCursor(page.nextCursor);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Key className="h-3.5 w-3.5 text-slate-500" />
          Permission &amp; admin tracking
        </div>
      </div>
      {events.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-slate-500">No permission events yet.</div>
      ) : (
        <ul>
          {events.map((e) => (
            <li
              key={e.id}
              className="flex items-start gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-slate-50/40"
            >
              <span
                className={`mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                  CATEGORY_STYLES[e.category]
                }`}
              >
                {e.category.replace(/_/g, " ")}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-slate-900">{e.detail}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                  <span>{timeAgo(e.ts)}</span>
                  {e.actor ? <span>· {e.actor}</span> : null}
                  {e.tenantId ? (
                    <a href={`/admin/tenants/${e.tenantId}`} className="font-mono hover:underline">
                      · tenant {e.tenantId.slice(0, 8)}
                    </a>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <div className="border-t border-slate-100 bg-slate-50/40 px-4 py-2 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-3 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronRight className="h-3 w-3" />}
            Load more
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ─── Top-level client ──────────────────────────────────────────────

export default function SecurityClient({ initial }: { initial: Initial }) {
  const [kpis, setKpis] = React.useState<SecurityKpiBundle | null>(initial.kpis);
  const [ipIntel, setIpIntel] = React.useState<IpIntelligence | null>(initial.ipIntel);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());

  const refreshAll = React.useCallback(async () => {
    if (document.hidden) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/security", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { kpis: SecurityKpiBundle | null; ipIntel: IpIntelligence | null };
        setKpis(data.kpis);
        setIpIntel(data.ipIntel);
        setLastRefreshAt(Date.now());
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(refreshAll, 60_000);
    return () => window.clearInterval(id);
  }, [refreshAll]);

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Security &amp; Audit Operations</div>
            <div className="text-[11px] text-slate-500">
              Auto-refresh every 60s · last {timeAgo(new Date(lastRefreshAt).toISOString())}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={refreshAll}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <ShieldAlert className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Security overview</h2>
          {kpis ? <span className="text-[11px] text-slate-400">{kpis.computedInMs}ms</span> : null}
        </div>
        <KpiGrid data={kpis} />
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Globe className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">IP intelligence</h2>
        </div>
        <IpIntelSection data={ipIntel} />
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Users className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Permission &amp; admin tracking</h2>
        </div>
        <PermissionFeed initial={initial.permissions} />
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Audit explorer</h2>
        </div>
        <AuditExplorer initial={initial.audit} />
      </section>
    </div>
  );
}
