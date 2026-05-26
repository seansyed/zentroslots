"use client";

/**
 * Admin Diagnostics — Reliability Intelligence Center.
 *
 * Premium upgrade of the existing schema-drift / KPI-smoke / snapshot-
 * freshness / cache stats surface. Same deterministic substrate, now
 * wrapped in Stripe-/Datadog-/Cloudflare-class reliability UX:
 *
 *   • DiagnosticsMissionHero — 7 composite reliability tiles + posture rail
 *   • Premium schema drift / KPI / snapshot / cache cards with confidence
 *     rings, freshness rails, severity glow
 *   • Investigation drawer (click any KPI, snapshot, drift entry)
 *   • Deterministic insight chips per section
 *   • Live heartbeat topbar
 *
 * No new SQL queries. All scores derived client-side from the existing
 * DiagnosticsBundle.
 */

import * as React from "react";
import {
  AlertCircle,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  Gauge,
  HeartPulse,
  Lightbulb,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Workflow,
  Wrench,
  X,
} from "lucide-react";

import type {
  AggregationSmokeTest,
  DiagnosticsBundle,
  SnapshotFreshness,
} from "@/lib/admin-analytics/diagnostics";
import type { SchemaDrift } from "@/lib/admin-analytics/schema-fingerprint";
import {
  deriveDiagnosticsReliability,
  deriveReliabilityInsights,
} from "@/lib/admin-analytics/diagnostics-reliability";
import DiagnosticsMissionHero, {
  ReliabilityInsightChip,
} from "@/components/admin/DiagnosticsMissionHero";

// ─── Helpers ──────────────────────────────────────────────────────

function ageLabel(min: number | null): string {
  if (min === null) return "—";
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ─── Schema drift section ─────────────────────────────────────────

function SchemaSection({
  drift,
  totalChecks,
  onOpen,
  storytellingChip,
}: {
  drift: SchemaDrift[];
  totalChecks: number;
  onOpen: (d: SchemaDrift) => void;
  storytellingChip?: React.ReactNode;
}) {
  if (drift.length === 0) {
    return (
      <div className="space-y-3">
        {storytellingChip ? <div className="flex items-center gap-2">{storytellingChip}</div> : null}
        <div className="rounded-2xl border border-dashed border-emerald-200/70 bg-gradient-to-br from-emerald-50/30 via-white to-white px-6 py-10 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-200/60">
            <ShieldCheck className="h-6 w-6 text-emerald-500" />
          </div>
          <div className="mt-3 text-sm font-semibold text-slate-900">Schema fingerprint healthy</div>
          <div className="mt-1 text-[12px] text-slate-500">
            All <span className="font-semibold tabular-nums">{totalChecks}</span> expected (table,
            column) pairs verified against information_schema.columns.
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {storytellingChip ? <div className="flex items-center gap-2">{storytellingChip}</div> : null}
      <div className="overflow-hidden rounded-2xl border border-rose-200 bg-gradient-to-br from-white to-rose-50/30 shadow-[0_0_0_1px_rgba(244,63,94,0.06)]">
        <div className="border-b border-rose-200/60 bg-gradient-to-r from-rose-50/60 to-white px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-rose-900">
            <AlertTriangle className="h-4 w-4 text-rose-700" />
            Schema drift detected — {drift.length} table{drift.length === 1 ? "" : "s"} affected
          </div>
          <div className="mt-0.5 text-[11px] text-rose-700">
            {totalChecks} (table, column) pairs verified against information_schema.columns. Click
            any row to investigate.
          </div>
        </div>
        <ul>
          {drift.map((d) => (
            <li
              key={d.table}
              className="relative border-b border-rose-200/60 px-4 py-3 pl-5 transition-colors last:border-b-0 hover:bg-rose-50/40 before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] before:bg-rose-500/80"
            >
              <button type="button" onClick={() => onOpen(d)} className="flex w-full items-start gap-3 text-left">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-slate-900">{d.table}</span>
                    {d.tableMissing ? (
                      <span className="inline-flex items-center rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-800">
                        table missing
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800">
                        {d.missingColumns.length} column{d.missingColumns.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  {d.tableMissing ? (
                    <div className="mt-1 text-[12px] text-rose-700">
                      <strong>Table missing entirely.</strong> Verify migration applied.
                    </div>
                  ) : (
                    <div className="mt-1 flex flex-wrap gap-1.5 text-[12px] text-rose-700">
                      Missing:
                      {d.missingColumns.map((c) => (
                        <span
                          key={c}
                          className="inline-flex items-center rounded-full border border-rose-200 bg-white px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <ChevronRight className="mt-1 h-3 w-3 shrink-0 text-rose-300" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ─── KPI smoke section ────────────────────────────────────────────

function KpiSmokeSection({
  tests,
  onOpen,
  storytellingChip,
}: {
  tests: AggregationSmokeTest[];
  onOpen: (t: AggregationSmokeTest) => void;
  storytellingChip?: React.ReactNode;
}) {
  const failures = tests.filter((t) => !t.ok);
  if (tests.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-200 bg-gradient-to-br from-slate-50/40 to-white px-4 py-10 text-center text-[12px] text-slate-500">
        No KPI smoke results yet.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {storytellingChip ? <div className="flex items-center gap-2">{storytellingChip}</div> : null}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="border-b border-slate-100 bg-gradient-to-r from-slate-50/80 to-white px-4 py-3">
          <div className="flex items-center justify-between gap-2 text-[13px] font-semibold tracking-tight text-slate-900">
            <span className="flex items-center gap-1.5">
              <Gauge className="h-3.5 w-3.5 text-slate-500" />
              KPI smoke tests
            </span>
            <span className="text-[11px] font-medium">
              {failures.length === 0 ? (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 ring-1 ring-emerald-200">
                  {tests.length}/{tests.length} OK
                </span>
              ) : (
                <span className="rounded-full bg-rose-50 px-2 py-0.5 text-rose-700 ring-1 ring-rose-200">
                  {failures.length}/{tests.length} failing
                </span>
              )}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            Each KPI is re-run through the safe() wrapper · categorical errors captured · click to
            investigate.
          </div>
        </div>
        <ul>
          {tests.map((t) => {
            const railCls = t.ok ? "before:bg-emerald-400/50" : "before:bg-rose-500/80";
            return (
              <li
                key={t.kpiKey}
                className={`relative flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 pl-5 transition-colors last:border-b-0 before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${railCls} ${
                  t.ok ? "hover:bg-slate-50/60" : "bg-rose-50/30 hover:bg-rose-50/50"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onOpen(t)}
                  className="flex w-full items-center justify-between gap-3 text-left"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    {t.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-600" />
                    )}
                    <span className="font-mono text-[12px] font-semibold text-slate-800">
                      {t.kpiKey}
                    </span>
                    {t.ms > 0 ? (
                      <span className="text-[10px] tabular-nums text-slate-400">{t.ms}ms</span>
                    ) : null}
                  </div>
                  {t.error ? (
                    <span
                      className="truncate text-right text-[11px] text-rose-700"
                      title={t.error}
                    >
                      {t.error}
                    </span>
                  ) : null}
                  <ChevronRight className="h-3 w-3 shrink-0 text-slate-300" />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ─── Snapshot freshness section ───────────────────────────────────

const FRESHNESS_TONE: Record<
  SnapshotFreshness["status"],
  {
    ring: string;
    bg: string;
    dot: string;
    rail: string;
    label: string;
    chip: string;
  }
> = {
  ok: {
    ring: "border-emerald-200",
    bg: "from-white to-emerald-50/30",
    dot: "bg-emerald-500",
    rail: "before:bg-emerald-400/60",
    label: "Fresh",
    chip: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  stale: {
    ring: "border-amber-200",
    bg: "from-white to-amber-50/30",
    dot: "bg-amber-500",
    rail: "before:bg-amber-400/70",
    label: "Stale",
    chip: "bg-amber-50 text-amber-700 ring-amber-200",
  },
  down: {
    ring: "border-rose-200 shadow-[0_0_0_1px_rgba(244,63,94,0.06)]",
    bg: "from-white to-rose-50/30",
    dot: "bg-rose-500",
    rail: "before:bg-rose-500/80",
    label: "Down",
    chip: "bg-rose-50 text-rose-700 ring-rose-200",
  },
  empty: {
    ring: "border-slate-200",
    bg: "from-white to-slate-50/30",
    dot: "bg-slate-300",
    rail: "before:bg-slate-300/60",
    label: "Empty",
    chip: "bg-slate-100 text-slate-600 ring-slate-200",
  },
};

function FreshnessBar({ ageMin, expectedMin }: { ageMin: number | null; expectedMin: number }) {
  if (ageMin === null) return <span className="text-[11px] text-slate-400">no rows yet</span>;
  // Visualize 0..6× expected
  const pct = Math.min(100, (ageMin / (expectedMin * 6)) * 100);
  const tone =
    ageMin <= expectedMin * 3
      ? "bg-emerald-400"
      : ageMin <= expectedMin * 6
      ? "bg-amber-400"
      : "bg-rose-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 w-16 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${tone} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-slate-500">{ageLabel(ageMin)} ago</span>
    </div>
  );
}

function SnapshotFreshnessSection({
  rows,
  onOpen,
  storytellingChip,
}: {
  rows: SnapshotFreshness[];
  onOpen: (s: SnapshotFreshness) => void;
  storytellingChip?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      {storytellingChip ? <div className="flex items-center gap-2">{storytellingChip}</div> : null}
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-4">
        {rows.map((r) => {
          const tone = FRESHNESS_TONE[r.status];
          const pulsing = r.status === "down";
          return (
            <button
              key={r.table}
              type="button"
              onClick={() => onOpen(r)}
              className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-3.5 pl-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_4px_18px_rgba(15,23,42,0.06)] before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${tone.ring} ${tone.bg} ${tone.rail}`}
            >
              <div className="flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wider">
                <span className="flex items-center gap-1.5 text-slate-600">
                  <span className="relative inline-flex h-2 w-2">
                    {pulsing ? (
                      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${tone.dot}`} />
                    ) : null}
                    <span className={`relative inline-flex h-2 w-2 rounded-full ${tone.dot}`} />
                  </span>
                  {tone.label}
                </span>
                <span className="text-slate-400">every {r.expectedIntervalMin}m</span>
              </div>
              <div className="mt-1.5 truncate font-mono text-[13px] font-semibold text-slate-900">
                {r.table}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <FreshnessBar ageMin={r.ageMinutes} expectedMin={r.expectedIntervalMin} />
                <ChevronRight className="h-3 w-3 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Cache section ────────────────────────────────────────────────

function CacheCard({
  bundle,
  utilization,
  health,
  storytellingChip,
}: {
  bundle: DiagnosticsBundle;
  utilization: number;
  health: number;
  storytellingChip?: React.ReactNode;
}) {
  const tone =
    health >= 90
      ? { ring: "border-emerald-200", bar: "bg-emerald-500", text: "text-emerald-700" }
      : health >= 75
      ? { ring: "border-sky-200", bar: "bg-sky-500", text: "text-sky-700" }
      : { ring: "border-amber-200", bar: "bg-amber-500", text: "text-amber-700" };
  return (
    <div className="space-y-3">
      {storytellingChip ? <div className="flex items-center gap-2">{storytellingChip}</div> : null}
      <div
        className={`rounded-2xl border bg-gradient-to-br from-white to-slate-50/30 p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${tone.ring}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-100 ring-1 ring-slate-200">
              <Boxes className="h-4 w-4 text-slate-600" />
            </div>
            <div>
              <div className="text-[13px] font-semibold tracking-tight text-slate-900">
                In-process analytics cache
              </div>
              <div className="text-[11px] text-slate-500">
                LRU sweet spot: 5–80% utilization
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-[18px] font-semibold tabular-nums text-slate-900">
              {bundle.cache.size}
              <span className="text-[12px] font-normal text-slate-400"> / {bundle.cache.max}</span>
            </div>
            <div className={`text-[11px] font-medium ${tone.text}`}>{utilization}% utilization</div>
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full ${tone.bar} transition-all duration-700`}
            style={{ width: `${Math.min(100, utilization)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Investigation drawer ─────────────────────────────────────────

type InvestigationTarget =
  | { kind: "kpi"; test: AggregationSmokeTest }
  | { kind: "snapshot"; row: SnapshotFreshness }
  | { kind: "drift"; drift: SchemaDrift };

function InvestigationDrawer({
  target,
  onClose,
}: {
  target: InvestigationTarget | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!target) return null;

  let title = "";
  let subtitle = "";
  let toneChip: { bg: string; text: string; ring: string; label: string } = {
    bg: "bg-slate-100",
    text: "text-slate-700",
    ring: "ring-slate-200",
    label: "",
  };
  let icon: React.ComponentType<{ className?: string }> = Wrench;
  let headerGradient = "from-slate-50/80 via-white to-white";

  if (target.kind === "kpi") {
    title = target.test.kpiKey;
    subtitle = target.test.ok
      ? `Smoke test passed${target.test.ms > 0 ? ` in ${target.test.ms}ms` : ""}`
      : `Smoke test failing${target.test.ms > 0 ? ` · ${target.test.ms}ms` : ""}`;
    toneChip = target.test.ok
      ? { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200", label: "Passing" }
      : { bg: "bg-rose-50", text: "text-rose-700", ring: "ring-rose-200", label: "Failing" };
    icon = Gauge;
    if (!target.test.ok) headerGradient = "from-rose-50/60 via-white to-white";
  } else if (target.kind === "snapshot") {
    title = target.row.table;
    subtitle =
      target.row.ageMinutes !== null
        ? `Last snapshot ${ageLabel(target.row.ageMinutes)} ago · expected every ${target.row.expectedIntervalMin}m`
        : "No snapshots written yet";
    toneChip = FRESHNESS_TONE[target.row.status].chip
      .split(" ")
      .reduce(
        (acc, cls) => {
          if (cls.startsWith("bg-")) acc.bg = cls;
          else if (cls.startsWith("text-")) acc.text = cls;
          else if (cls.startsWith("ring-")) acc.ring = cls;
          return acc;
        },
        { bg: "", text: "", ring: "", label: FRESHNESS_TONE[target.row.status].label },
      );
    icon = HeartPulse;
    if (target.row.status === "down") headerGradient = "from-rose-50/60 via-white to-white";
    else if (target.row.status === "stale") headerGradient = "from-amber-50/60 via-white to-white";
  } else {
    title = target.drift.table;
    subtitle = target.drift.tableMissing
      ? "Entire table missing from live schema"
      : `${target.drift.missingColumns.length} column${target.drift.missingColumns.length === 1 ? "" : "s"} missing`;
    toneChip = { bg: "bg-rose-50", text: "text-rose-700", ring: "ring-rose-200", label: "Drift" };
    icon = Database;
    headerGradient = "from-rose-50/60 via-white to-white";
  }

  const Icon = icon;

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
          className={`sticky top-0 z-10 border-b border-slate-200 bg-gradient-to-br ${headerGradient} px-6 py-5`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ${toneChip.bg} ${toneChip.text} ${toneChip.ring}`}
                >
                  <Icon className="h-2.5 w-2.5" />
                  {toneChip.label}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-700">
                  {target.kind === "kpi" ? "KPI" : target.kind === "snapshot" ? "Snapshot" : "Schema"}
                </span>
              </div>
              <h2 className="mt-2 break-all font-mono text-base font-semibold tracking-tight text-slate-900">
                {title}
              </h2>
              <div className="mt-1 text-[12px] text-slate-500">{subtitle}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="space-y-5 px-6 py-5">
          {target.kind === "kpi" ? <KpiDrawerBody test={target.test} /> : null}
          {target.kind === "snapshot" ? <SnapshotDrawerBody row={target.row} /> : null}
          {target.kind === "drift" ? <DriftDrawerBody drift={target.drift} /> : null}

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Repair recommendations
            </div>
            <ul className="space-y-2 text-[12px] text-slate-700">
              {target.kind === "kpi" ? (
                target.test.ok ? (
                  <li className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    <span>No action required — KPI is currently passing its smoke test.</span>
                  </li>
                ) : (
                  <>
                    <DrawerHint text="Inspect the categorical error string and trace the SQL it points to." />
                    <DrawerHint text="Cross-reference schema fingerprint above — drift commonly causes KPI failures." />
                    <DrawerHint text="Re-run /api/admin/diagnostics after fix to confirm recovery." />
                  </>
                )
              ) : target.kind === "snapshot" ? (
                target.row.status === "ok" ? (
                  <li className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/40 px-3 py-2">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    <span>Snapshot freshness within expected cadence — no action required.</span>
                  </li>
                ) : target.row.status === "empty" ? (
                  <>
                    <DrawerHint text="Snapshot table has zero rows — verify the generating cron job has executed at least once." />
                    <DrawerHint text="If this is a new environment, the first scheduled run will populate it." />
                  </>
                ) : (
                  <>
                    <DrawerHint
                      text={`Snapshot is ${target.row.status === "down" ? "down" : "stale"}. Check the corresponding cron job (admin:snapshots:*) in /admin/ops.`}
                    />
                    <DrawerHint text="If worker is alive but snapshot not advancing, inspect cron_runs.detail for the latest failure reason." />
                    <DrawerHint text="Confirm DB connectivity + table partition write permissions." />
                  </>
                )
              ) : (
                <>
                  {target.drift.tableMissing ? (
                    <DrawerHint text="Table is missing entirely. Confirm the corresponding migration has been applied on this environment." />
                  ) : (
                    <DrawerHint text="Columns missing on live schema. Re-run latest migration or correct the offending query." />
                  )}
                  <DrawerHint text="Cross-reference db/schema.ts vs the live information_schema.columns for the missing names." />
                  <DrawerHint text="Until resolved, KPIs that depend on this table will surface 'Unable to compute'." />
                </>
              )}
            </ul>
            <p className="mt-3 text-[11px] italic text-slate-500">
              Read-only diagnostics — no autonomous repair. All recovery actions remain manual,
              audited, and operator-confirmed.
            </p>
          </section>

          <section>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Quick actions
            </div>
            <div className="grid grid-cols-2 gap-2">
              <DrawerLink href="/admin/ops" label="Open ops diagnostics" Icon={Workflow} />
              <DrawerLink href="/admin/activity" label="Open activity feed" Icon={Clock} />
              <DrawerLink href="/admin/intelligence" label="Open intelligence" Icon={ShieldCheck} />
              <DrawerLink href="/admin/security" label="Open security ops" Icon={ShieldCheck} />
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

function DrawerHint({ text }: { text: string }) {
  return (
    <li className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50/30 px-3 py-2">
      <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
      <span>{text}</span>
    </li>
  );
}

function KpiDrawerBody({ test }: { test: AggregationSmokeTest }) {
  return (
    <section>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        Smoke test context
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        <DrawerField label="KPI key" value={<code className="text-[11px]">{test.kpiKey}</code>} />
        <DrawerField
          label="Status"
          value={
            <span className={test.ok ? "font-semibold text-emerald-700" : "font-semibold text-rose-700"}>
              {test.ok ? "Passing" : "Failing"}
            </span>
          }
        />
        <DrawerField
          label="Execution time"
          value={test.ms > 0 ? `${test.ms}ms` : <span className="text-slate-400">—</span>}
        />
        <DrawerField
          label="Error"
          value={
            test.error ? (
              <span className="text-rose-700">{test.error}</span>
            ) : (
              <span className="text-slate-400">none</span>
            )
          }
        />
      </dl>
    </section>
  );
}

function SnapshotDrawerBody({ row }: { row: SnapshotFreshness }) {
  return (
    <section>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        Snapshot freshness
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        <DrawerField label="Table" value={<code className="text-[11px]">{row.table}</code>} />
        <DrawerField
          label="Status"
          value={
            <span
              className={
                row.status === "ok"
                  ? "font-semibold text-emerald-700"
                  : row.status === "stale"
                  ? "font-semibold text-amber-700"
                  : row.status === "down"
                  ? "font-semibold text-rose-700"
                  : "font-semibold text-slate-500"
              }
            >
              {FRESHNESS_TONE[row.status].label}
            </span>
          }
        />
        <DrawerField
          label="Last snapshot"
          value={row.latestAt ? timeAgo(row.latestAt) : <span className="text-slate-400">never</span>}
        />
        <DrawerField label="Expected cadence" value={`every ${row.expectedIntervalMin}m`} />
        <DrawerField
          label="Current age"
          value={
            row.ageMinutes !== null ? (
              <span className="font-semibold tabular-nums">{ageLabel(row.ageMinutes)}</span>
            ) : (
              <span className="text-slate-400">—</span>
            )
          }
        />
      </dl>
    </section>
  );
}

function DriftDrawerBody({ drift }: { drift: SchemaDrift }) {
  return (
    <section>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        Schema drift detail
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        <DrawerField label="Table" value={<code className="text-[11px]">{drift.table}</code>} />
        <DrawerField
          label="Kind"
          value={
            drift.tableMissing ? (
              <span className="font-semibold text-rose-700">Table missing</span>
            ) : (
              <span className="font-semibold text-amber-700">Columns missing</span>
            )
          }
        />
      </dl>
      {drift.missingColumns.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            Missing columns
          </div>
          <div className="flex flex-wrap gap-1.5">
            {drift.missingColumns.map((c) => (
              <span
                key={c}
                className="inline-flex items-center rounded-md border border-rose-200 bg-rose-50/40 px-1.5 py-0.5 font-mono text-[11px] text-rose-700"
              >
                {c}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function DrawerField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-words font-medium text-slate-800">{value}</dd>
    </>
  );
}

function DrawerLink({
  href,
  label,
  Icon,
}: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <a
      href={href}
      className="group inline-flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-700 transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:bg-slate-50 hover:shadow-[0_4px_12px_rgba(15,23,42,0.05)]"
    >
      <span className="inline-flex items-center gap-2">
        <Icon className="h-3 w-3 text-slate-400 group-hover:text-slate-600" />
        {label}
      </span>
      <ChevronRight className="h-3 w-3 text-slate-300 group-hover:translate-x-0.5 group-hover:text-slate-500" />
    </a>
  );
}

// ─── Top-level client ─────────────────────────────────────────────

export default function DiagnosticsClient({ initial }: { initial: DiagnosticsBundle | null }) {
  const [data, setData] = React.useState<DiagnosticsBundle | null>(initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());
  const [investigation, setInvestigation] = React.useState<InvestigationTarget | null>(null);
  const [heartbeatTick, setHeartbeatTick] = React.useState(0);

  const refresh = React.useCallback(async () => {
    if (document.hidden) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/diagnostics", { cache: "no-store" });
      if (res.ok) {
        setData((await res.json()) as DiagnosticsBundle);
        setLastRefreshAt(Date.now());
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  React.useEffect(() => {
    const id = window.setInterval(() => setHeartbeatTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const reliability = data ? deriveDiagnosticsReliability(data) : null;
  const insights = data && reliability ? deriveReliabilityInsights(data, reliability) : [];

  const schemaInsight = insights.find((i) => i.surface === "schema") ?? null;
  const kpisInsight = insights.find((i) => i.surface === "kpis") ?? null;
  const snapshotsInsight = insights.find((i) => i.surface === "snapshots") ?? null;
  const cacheInsight = insights.find((i) => i.surface === "cache") ?? null;

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

      {/* Sticky topbar with heartbeat */}
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
            <div className="text-[13px] font-semibold tracking-tight text-slate-900">Diagnostics</div>
            <div className="text-[11px] text-slate-500">
              Continuously verified · schema + KPIs + snapshots + cache · refresh every 60s · last{" "}
              {timeAgo(new Date(lastRefreshAt).toISOString())}
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

      {/* Mission hero */}
      {data && reliability ? (
        <DiagnosticsMissionHero kpis={reliability} insights={insights} liveOn={!refreshing} />
      ) : null}

      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <Database className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Schema fingerprint
          </h2>
          {data ? (
            <span className="text-[11px] text-slate-400">
              {data.schemaFingerprint.totalChecks} pairs verified
            </span>
          ) : null}
        </div>
        {data ? (
          <SchemaSection
            drift={data.schemaFingerprint.drift}
            totalChecks={data.schemaFingerprint.totalChecks}
            onOpen={(d) => setInvestigation({ kind: "drift", drift: d })}
            storytellingChip={schemaInsight ? <ReliabilityInsightChip insight={schemaInsight} /> : null}
          />
        ) : (
          <div className="h-[80px] animate-pulse rounded-2xl border border-slate-200 bg-slate-50/50" />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <Gauge className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            KPI aggregation smoke tests
          </h2>
          {data ? (
            <span className="text-[11px] text-slate-400">
              {data.aggregationSmokeTests.filter((t) => t.ok).length}/
              {data.aggregationSmokeTests.length} passing
            </span>
          ) : null}
        </div>
        {data ? (
          <KpiSmokeSection
            tests={data.aggregationSmokeTests}
            onOpen={(t) => setInvestigation({ kind: "kpi", test: t })}
            storytellingChip={kpisInsight ? <ReliabilityInsightChip insight={kpisInsight} /> : null}
          />
        ) : (
          <div className="h-[200px] animate-pulse rounded-2xl border border-slate-200 bg-slate-50/50" />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <HeartPulse className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Snapshot freshness
          </h2>
          {data && reliability ? (
            <span className="text-[11px] text-slate-400">
              {reliability.snapshotOkCount}/{reliability.snapshotTotal} fresh
            </span>
          ) : null}
        </div>
        {data ? (
          <SnapshotFreshnessSection
            rows={data.snapshotFreshness}
            onOpen={(s) => setInvestigation({ kind: "snapshot", row: s })}
            storytellingChip={
              snapshotsInsight ? <ReliabilityInsightChip insight={snapshotsInsight} /> : null
            }
          />
        ) : (
          <div className="h-[80px] animate-pulse rounded-2xl border border-slate-200 bg-slate-50/50" />
        )}
      </section>

      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <Boxes className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">Cache stats</h2>
        </div>
        {data && reliability ? (
          <CacheCard
            bundle={data}
            utilization={reliability.cacheUtilizationPct}
            health={reliability.cacheHealth}
            storytellingChip={cacheInsight ? <ReliabilityInsightChip insight={cacheInsight} /> : null}
          />
        ) : (
          <div className="h-[80px] animate-pulse rounded-2xl border border-slate-200 bg-slate-50/50" />
        )}
      </section>

      <InvestigationDrawer target={investigation} onClose={() => setInvestigation(null)} />
    </div>
  );
}
