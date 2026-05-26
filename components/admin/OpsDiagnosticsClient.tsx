"use client";

/**
 * Stabilization Wave — Operator diagnostics panel.
 *
 * Three sections:
 *   • Cron heartbeat grid    — every job's last-run state + status pill
 *   • Stuck queues           — bookings/automations/webhooks needing attention
 *   • Recent failures (24h)  — cron + audit failure stream
 */

import * as React from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  Loader2,
  RefreshCw,
} from "lucide-react";

import type {
  CronHeartbeat,
  CronStatus,
  OpsDiagnosticsBundle,
  RecentFailure,
  StuckQueueRow,
} from "@/lib/admin-analytics/opsDiagnostics";

const STATUS_TONE: Record<CronStatus, { ring: string; dot: string; label: string }> = {
  ok: { ring: "border-emerald-200 bg-emerald-50/30", dot: "bg-emerald-500", label: "OK" },
  stale: { ring: "border-amber-200 bg-amber-50/30", dot: "bg-amber-500", label: "Stale" },
  down: { ring: "border-rose-200 bg-rose-50/30", dot: "bg-rose-500 animate-pulse", label: "Down" },
  running: { ring: "border-sky-200 bg-sky-50/30", dot: "bg-sky-500 animate-pulse", label: "Running" },
  unknown: { ring: "border-slate-200 bg-white", dot: "bg-slate-300", label: "Unknown" },
};

function ageLabel(min: number | null): string {
  if (min === null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

function CronGrid({ rows }: { rows: CronHeartbeat[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/40 px-4 py-8 text-center text-[12px] text-slate-500">
        No cron history yet — first run will populate this.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((r) => {
        const tone = STATUS_TONE[r.status];
        return (
          <div
            key={r.jobName}
            className={`rounded-xl border p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${tone.ring}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-600">
                <span className={`inline-flex h-2 w-2 rounded-full ${tone.dot}`} />
                {tone.label}
              </div>
              <span className="text-[10px] text-slate-400">
                {r.expectedIntervalMin ? `every ${r.expectedIntervalMin}m` : ""}
              </span>
            </div>
            <div className="mt-1 truncate font-mono text-[13px] font-medium text-slate-900">
              {r.jobName}
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
              <span>last {ageLabel(r.ageMinutes)} ago</span>
              <span>
                {r.lastDurationMs !== null ? `${r.lastDurationMs}ms` : "—"}
                {r.failedRuns24h > 0 ? (
                  <span className="ml-2 text-rose-700">{r.failedRuns24h} fails/24h</span>
                ) : null}
              </span>
            </div>
            {r.lastDetail && Object.keys(r.lastDetail).length > 0 ? (
              <div className="mt-2 truncate font-mono text-[10px] text-slate-500">
                {Object.entries(r.lastDetail)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join(" ")}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function StuckQueues({ rows }: { rows: StuckQueueRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50/30 px-4 py-6 text-center text-[12px] text-emerald-700">
        <CheckCircle2 className="mx-auto mb-1 h-4 w-4" />
        No stuck queues detected.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/30 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <ul>
        {rows.map((r) => (
          <li key={r.kind} className="flex items-start gap-3 border-b border-amber-200 px-4 py-3 last:border-b-0">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-medium text-slate-900">{r.label}</span>
                <span className="text-[18px] font-semibold text-amber-700">{r.count}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-slate-600">{r.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentFailures({ rows }: { rows: RecentFailure[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-emerald-200 bg-emerald-50/30 px-4 py-6 text-center text-[12px] text-emerald-700">
        <CheckCircle2 className="mx-auto mb-1 h-4 w-4" />
        No failures in the last 24h.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <table className="w-full">
        <thead className="bg-slate-50 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Source</th>
            <th className="px-3 py-2">Label</th>
            <th className="px-3 py-2">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-slate-100 text-[12px] hover:bg-slate-50/40">
              <td className="whitespace-nowrap px-3 py-2 text-slate-600">
                {new Date(r.ts).toLocaleString()}
              </td>
              <td className="px-3 py-2">
                <span
                  className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                    r.source === "cron" ? "bg-violet-50 text-violet-700" : "bg-rose-50 text-rose-700"
                  }`}
                >
                  {r.source}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-[11px] text-slate-800">{r.label}</td>
              <td className="px-3 py-2 text-[11px] text-slate-600">
                <span className="line-clamp-1">{r.detail}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OpsDiagnosticsClient({
  initial,
}: {
  initial: OpsDiagnosticsBundle | null;
}) {
  const [data, setData] = React.useState<OpsDiagnosticsBundle | null>(initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());

  const refresh = React.useCallback(async () => {
    if (document.hidden) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/ops", { cache: "no-store" });
      if (res.ok) {
        const payload = (await res.json()) as OpsDiagnosticsBundle;
        setData(payload);
        setLastRefreshAt(Date.now());
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(refresh, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Operator Diagnostics</div>
            <div className="text-[11px] text-slate-500">
              Cron heartbeats · stuck queues · 24h failure stream · refresh every 30s
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Refresh
        </button>
      </div>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Stuck queues</h2>
        </div>
        <StuckQueues rows={data?.stuckQueues ?? []} />
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Cron heartbeat</h2>
          <span className="text-[11px] text-slate-400">{data?.cronHeartbeats.length ?? 0} jobs</span>
        </div>
        <CronGrid rows={data?.cronHeartbeats ?? []} />
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <AlertCircle className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Recent failures (24h)</h2>
          <span className="text-[11px] text-slate-400">{data?.recentFailures.length ?? 0}</span>
        </div>
        <RecentFailures rows={data?.recentFailures ?? []} />
      </section>
    </div>
  );
}
