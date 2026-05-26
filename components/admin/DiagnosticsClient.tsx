"use client";

/**
 * /admin/diagnostics — Schema drift + KPI smoke + snapshot freshness.
 *
 * Four sections:
 *   §A Schema fingerprint   — pass/fail per table; lists missing columns
 *   §B KPI smoke tests      — every KPI, ok/err + categorical error
 *   §C Snapshot freshness   — age vs expected interval per snapshot table
 *   §D Cache stats          — in-process LRU size
 *
 * Refresh: manual + every 60s. Every signal is read-only.
 */

import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Database,
  Gauge,
  Loader2,
  RefreshCw,
  Wrench,
} from "lucide-react";

import type {
  AggregationSmokeTest,
  DiagnosticsBundle,
  SnapshotFreshness,
} from "@/lib/admin-analytics/diagnostics";
import type { SchemaDrift } from "@/lib/admin-analytics/schema-fingerprint";

function ageLabel(min: number | null): string {
  if (min === null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

function SchemaSection({ drift, totalChecks }: { drift: SchemaDrift[]; totalChecks: number }) {
  if (drift.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50/30 px-4 py-4 text-sm">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-700" />
          <span className="font-medium text-emerald-900">Schema healthy</span>
        </div>
        <div className="mt-1 text-[12px] text-emerald-700">
          All {totalChecks} expected (table, column) pairs found in the live database.
        </div>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-rose-200 bg-rose-50/30 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-rose-200 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-rose-900">
          <AlertTriangle className="h-4 w-4 text-rose-700" />
          Schema drift detected — {drift.length} table{drift.length === 1 ? "" : "s"} affected
        </div>
        <div className="mt-0.5 text-[11px] text-rose-700">
          {totalChecks} (table, column) pairs verified against information_schema.columns. Re-run
          the relevant migration or fix the offending query.
        </div>
      </div>
      <ul>
        {drift.map((d) => (
          <li key={d.table} className="border-b border-rose-200 px-4 py-3 last:border-b-0">
            <div className="font-mono text-[13px] font-medium text-slate-900">{d.table}</div>
            {d.tableMissing ? (
              <div className="mt-1 text-[12px] text-rose-700">
                <strong>Table missing entirely.</strong> Check that the migration has been applied.
              </div>
            ) : (
              <div className="mt-1 text-[12px] text-rose-700">
                Missing columns:{" "}
                {d.missingColumns.map((c) => (
                  <span
                    key={c}
                    className="ml-1 inline-flex items-center rounded-full border border-rose-200 bg-white px-1.5 py-0.5 font-mono text-[11px]"
                  >
                    {c}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function KpiSmokeSection({ tests }: { tests: AggregationSmokeTest[] }) {
  const failures = tests.filter((t) => !t.ok);
  if (tests.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/40 px-4 py-6 text-center text-[12px] text-slate-500">
        No KPI smoke results yet.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
        <div className="flex items-center justify-between gap-2 text-sm font-medium text-slate-900">
          <span className="flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5 text-slate-500" />
            KPI smoke tests
          </span>
          <span className="text-[11px] font-normal">
            {failures.length === 0 ? (
              <span className="text-emerald-700">{tests.length}/{tests.length} OK</span>
            ) : (
              <span className="text-rose-700">{failures.length}/{tests.length} failing</span>
            )}
          </span>
        </div>
      </div>
      <ul>
        {tests.map((t) => (
          <li
            key={t.kpiKey}
            className={`flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2 last:border-b-0 ${
              !t.ok ? "bg-rose-50/30" : ""
            }`}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {t.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-600" />
              )}
              <span className="font-mono text-[12px] text-slate-800">{t.kpiKey}</span>
            </div>
            {t.error ? (
              <span className="truncate text-right text-[11px] text-rose-700" title={t.error}>
                {t.error}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

const FRESHNESS_TONE: Record<SnapshotFreshness["status"], { ring: string; dot: string; label: string }> = {
  ok: { ring: "border-emerald-200 bg-emerald-50/30", dot: "bg-emerald-500", label: "Fresh" },
  stale: { ring: "border-amber-200 bg-amber-50/30", dot: "bg-amber-500", label: "Stale" },
  down: { ring: "border-rose-200 bg-rose-50/30", dot: "bg-rose-500 animate-pulse", label: "Down" },
  empty: { ring: "border-slate-200 bg-white", dot: "bg-slate-300", label: "Empty" },
};

function SnapshotFreshnessSection({ rows }: { rows: SnapshotFreshness[] }) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
      {rows.map((r) => {
        const tone = FRESHNESS_TONE[r.status];
        return (
          <div
            key={r.table}
            className={`rounded-xl border p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${tone.ring}`}
          >
            <div className="flex items-center justify-between text-[10px] font-medium uppercase tracking-wider">
              <span className="flex items-center gap-1.5 text-slate-600">
                <span className={`inline-flex h-2 w-2 rounded-full ${tone.dot}`} />
                {tone.label}
              </span>
              <span className="text-slate-400">every {r.expectedIntervalMin}m</span>
            </div>
            <div className="mt-1 truncate font-mono text-[12px] font-medium text-slate-900">
              {r.table}
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
              <span>{r.latestAt ? `last ${ageLabel(r.ageMinutes)} ago` : "no rows yet"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function DiagnosticsClient({ initial }: { initial: DiagnosticsBundle | null }) {
  const [data, setData] = React.useState<DiagnosticsBundle | null>(initial);
  const [refreshing, setRefreshing] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (document.hidden) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/diagnostics", { cache: "no-store" });
      if (res.ok) {
        setData((await res.json()) as DiagnosticsBundle);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Diagnostics</div>
            <div className="text-[11px] text-slate-500">
              Schema fingerprint · KPI smoke · snapshot freshness · cache stats
              {data ? ` · computed in ${data.computedInMs}ms` : ""}
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
          <h2 className="text-sm font-medium text-slate-900">Schema fingerprint</h2>
        </div>
        {data ? (
          <SchemaSection
            drift={data.schemaFingerprint.drift}
            totalChecks={data.schemaFingerprint.totalChecks}
          />
        ) : (
          <div className="h-[80px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Gauge className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">KPI aggregation smoke tests</h2>
        </div>
        {data ? (
          <KpiSmokeSection tests={data.aggregationSmokeTests} />
        ) : (
          <div className="h-[200px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Snapshot freshness</h2>
        </div>
        {data ? (
          <SnapshotFreshnessSection rows={data.snapshotFreshness} />
        ) : (
          <div className="h-[80px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
        )}
      </section>

      <section>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-slate-600">In-process analytics cache</span>
            <span className="font-mono text-slate-900">
              {data ? `${data.cache.size} / ${data.cache.max}` : "—"}
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
