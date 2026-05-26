"use client";

/**
 * SA-8 — Operations Intelligence Center client.
 *
 * Renders eight sections off a single IntelligenceReport:
 *   §A Executive summary (counts by category + severity)
 *   §B Critical alerts (severity = critical)
 *   §C Growth opportunities (severity = opportunity)
 *   §D Churn risks (category = churn)
 *   §E Infrastructure warnings (category = infrastructure)
 *   §F Financial risks (category = financial)
 *   §G Trend analysis (category = operations)
 *   §H Recommendations queue (all insights, expand for actions)
 *
 * The intelligence engine is DETERMINISTIC — every value displayed
 * here comes from a real SQL query and a fixed threshold test. NO LLM,
 * NO predictions, NO inferred labels.
 */

import * as React from "react";
import {
  AlertTriangle,
  Brain,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Database,
  Heart,
  Lightbulb,
  ListChecks,
  Loader2,
  RefreshCw,
  Shield,
  Sparkles,
  TrendingUp,
  UserMinus,
} from "lucide-react";

import type {
  ImpactedTenant,
  Insight,
  InsightCategory,
  InsightKind,
  InsightSeverity,
  IntelligenceReport,
} from "@/lib/admin-analytics/intelligence";

const SEVERITY_TONE: Record<InsightSeverity, { ring: string; chip: string; dot: string; label: string }> = {
  critical: {
    ring: "border-rose-200 bg-rose-50/30",
    chip: "bg-rose-100 text-rose-800",
    dot: "bg-rose-500 animate-pulse",
    label: "Critical",
  },
  warning: {
    ring: "border-amber-200 bg-amber-50/30",
    chip: "bg-amber-100 text-amber-800",
    dot: "bg-amber-500",
    label: "Warning",
  },
  opportunity: {
    ring: "border-emerald-200 bg-emerald-50/30",
    chip: "bg-emerald-100 text-emerald-800",
    dot: "bg-emerald-500",
    label: "Opportunity",
  },
  info: {
    ring: "border-slate-200 bg-white",
    chip: "bg-slate-100 text-slate-700",
    dot: "bg-slate-400",
    label: "Info",
  },
};

const CATEGORY_ICON: Record<InsightCategory, React.ComponentType<{ className?: string }>> = {
  growth: TrendingUp,
  churn: UserMinus,
  financial: CreditCard,
  onboarding: ListChecks,
  infrastructure: Database,
  security: Shield,
  operations: Heart,
};

const CATEGORY_LABEL: Record<InsightCategory, string> = {
  growth: "Growth",
  churn: "Churn",
  financial: "Financial",
  onboarding: "Onboarding",
  infrastructure: "Infrastructure",
  security: "Security",
  operations: "Operations",
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ─── Section: Executive Summary ───────────────────────────────────

function ExecutiveSummary({ report }: { report: IntelligenceReport }) {
  const { summary } = report;
  const sevs: InsightSeverity[] = ["critical", "warning", "opportunity", "info"];
  return (
    <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-white to-slate-50/40 p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-slate-500">
            <Brain className="h-3.5 w-3.5" />
            Executive summary
          </div>
          <div className="mt-1 text-[28px] font-semibold leading-tight text-slate-900">
            {summary.total} active insight{summary.total === 1 ? "" : "s"}
          </div>
          <div className="mt-1 text-[12px] text-slate-500">
            Deterministic rule engine · {report.computedInMs}ms · generated {timeAgo(report.generatedAt)}
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {sevs.map((s) => {
          const tone = SEVERITY_TONE[s];
          const n = summary.bySeverity[s];
          return (
            <div key={s} className={`rounded-lg border p-2.5 ${tone.ring}`}>
              <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-slate-600">
                <span className={`inline-flex h-2 w-2 rounded-full ${tone.dot}`} />
                {tone.label}
              </div>
              <div className="mt-1 text-[20px] font-semibold leading-none text-slate-900">{n}</div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {(Object.keys(summary.byCategory) as InsightCategory[])
          .filter((c) => summary.byCategory[c] > 0)
          .map((c) => {
            const Icon = CATEGORY_ICON[c];
            return (
              <span
                key={c}
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
              >
                <Icon className="h-3 w-3" />
                {CATEGORY_LABEL[c]} · {summary.byCategory[c]}
              </span>
            );
          })}
      </div>
    </div>
  );
}

// ─── Insight card ─────────────────────────────────────────────────

function InsightCard({ insight }: { insight: Insight }) {
  const [expanded, setExpanded] = React.useState(false);
  const tone = SEVERITY_TONE[insight.severity];
  const Icon = CATEGORY_ICON[insight.category];
  return (
    <article
      className={`rounded-xl border p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-shadow hover:shadow-[0_4px_16px_rgba(15,23,42,0.06)] ${tone.ring}`}
    >
      <header className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-slate-200">
          <Icon className="h-4 w-4 text-slate-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone.chip}`}>
              <span className={`inline-flex h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              {tone.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-600">
              {CATEGORY_LABEL[insight.category]}
            </span>
            <span className="text-[11px] text-slate-400">
              confidence {insight.confidence}%
            </span>
          </div>
          <h3 className="mt-1 text-[14px] font-semibold text-slate-900">{insight.title}</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-700">{insight.explanation}</p>
        </div>
      </header>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-3 inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-700"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {expanded ? "Hide details" : "Show details"} ({insight.impactedTenants.length} impacted, {insight.recommendedActions.length} action{insight.recommendedActions.length === 1 ? "" : "s"})
      </button>

      {expanded ? (
        <div className="mt-3 space-y-3 border-t border-slate-200 pt-3">
          {Object.keys(insight.supportingData).length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                Supporting data
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(insight.supportingData).map(([k, v]) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px]"
                  >
                    <span className="text-slate-500">{k.replace(/_/g, " ")}:</span>
                    <span className="font-mono font-medium text-slate-800">{String(v)}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {insight.impactedTenants.length > 0 ? (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
                Impacted tenants
              </div>
              <ul className="space-y-1">
                {insight.impactedTenants.map((t) => (
                  <TenantRow key={t.id} tenant={t} />
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">
              Recommended actions
            </div>
            <ul className="space-y-1 text-[12px] text-slate-700">
              {insight.recommendedActions.map((a, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <Lightbulb className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function TenantRow({ tenant }: { tenant: ImpactedTenant }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px]">
      <a
        href={`/admin/tenants/${tenant.id}`}
        className="flex-1 truncate text-sky-700 hover:underline"
      >
        {tenant.name}
      </a>
      <span className="truncate text-[11px] text-slate-500">{tenant.detail}</span>
    </li>
  );
}

// ─── Bucketed sections ────────────────────────────────────────────

function SectionGroup({
  title,
  icon: Icon,
  insights,
  emptyText,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  insights: Insight[];
  emptyText: string;
}) {
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 text-slate-500" />
        <h2 className="text-sm font-medium text-slate-900">{title}</h2>
        <span className="text-[11px] text-slate-400">{insights.length}</span>
      </div>
      {insights.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/40 px-4 py-8 text-center text-[12px] text-slate-500">
          {emptyText}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {insights.map((i) => (
            <InsightCard key={i.id} insight={i} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Top-level client ────────────────────────────────────────────

export default function IntelligenceClient({ initial }: { initial: IntelligenceReport | null }) {
  const [report, setReport] = React.useState<IntelligenceReport | null>(initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());

  const refresh = React.useCallback(async () => {
    if (document.hidden) return;
    setRefreshing(true);
    try {
      const res = await fetch("/api/admin/intelligence", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as IntelligenceReport;
        setReport(data);
        setLastRefreshAt(Date.now());
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(refresh, 120_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!report) {
    return (
      <div className="space-y-3">
        <div className="h-[160px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[120px] animate-pulse rounded-xl border border-slate-200 bg-slate-50/50" />
        ))}
      </div>
    );
  }

  // Buckets — single source of truth.
  const all = report.insights;
  const critical = all.filter((i) => i.severity === "critical");
  const opportunities = all.filter((i) => i.severity === "opportunity");
  const churn = all.filter((i) => i.category === "churn");
  const infra = all.filter((i) => i.category === "infrastructure");
  const financial = all.filter((i) => i.category === "financial");
  const operations = all.filter((i) => i.category === "operations");

  return (
    <div className="space-y-6">
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Operations Intelligence</div>
            <div className="text-[11px] text-slate-500">
              Deterministic rule engine · refresh every 2m · last {timeAgo(new Date(lastRefreshAt).toISOString())}
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

      <ExecutiveSummary report={report} />

      <SectionGroup
        title="Critical alerts"
        icon={AlertTriangle}
        insights={critical}
        emptyText="No critical alerts. All threshold-based critical rules are quiet."
      />

      <SectionGroup
        title="Growth opportunities"
        icon={Sparkles}
        insights={opportunities}
        emptyText="No growth-flagged insights right now. Engine is monitoring signup velocity, expansion patterns, and upgrade candidates."
      />

      <SectionGroup
        title="Churn risks"
        icon={UserMinus}
        insights={churn}
        emptyText="No churn signals tripped today. Inactive-tenant + activity-drop rules are clean."
      />

      <SectionGroup
        title="Infrastructure warnings"
        icon={Database}
        insights={infra}
        emptyText="Infra rules are quiet — webhook + reminder + sync error ratios all under thresholds."
      />

      <SectionGroup
        title="Financial risks & opportunities"
        icon={CreditCard}
        insights={financial}
        emptyText="No financial-rule signals. Dunning + upgrade-candidate rules are quiet."
      />

      <SectionGroup
        title="Trend & seasonal analysis"
        icon={TrendingUp}
        insights={operations}
        emptyText="Booking volume is tracking normal weekday baselines."
      />

      <RecommendationsQueue insights={all} />

      <Footer />
    </div>
  );
}

function RecommendationsQueue({ insights }: { insights: Insight[] }) {
  const items = insights.flatMap((i) =>
    i.recommendedActions.map((a, idx) => ({
      key: `${i.id}:${idx}`,
      title: i.title,
      severity: i.severity,
      action: a,
      kind: i.kind,
    })),
  );
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <ListChecks className="h-3.5 w-3.5 text-slate-500" />
        <h2 className="text-sm font-medium text-slate-900">Recommendations queue</h2>
        <span className="text-[11px] text-slate-400">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/40 px-4 py-8 text-center text-[12px] text-slate-500">
          No active recommendations.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <ul>
            {items.map((it, idx) => {
              const tone = SEVERITY_TONE[it.severity];
              return (
                <li
                  key={it.key}
                  className="flex items-start gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 hover:bg-slate-50/40"
                >
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-medium text-slate-700">
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-slate-900">{it.action}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                      <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone.chip}`}>
                        {tone.label}
                      </span>
                      <span className="truncate">{it.title}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

function Footer() {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/30 px-4 py-3 text-[11px] text-slate-500">
      <div className="flex items-center gap-1.5 font-medium text-slate-600">
        <Shield className="h-3 w-3" />
        How this works
      </div>
      <p className="mt-1 leading-relaxed">
        Every insight on this page is generated by a deterministic SQL rule engine. There is{" "}
        <strong>no LLM</strong>, no machine learning, no inferred labels. Each insight's
        explanation, supporting data, and impacted tenants come from real DB queries against the
        tables noted in the explanation text. Refresh cadence: 2 minutes; cache TTL: 2 minutes.
      </p>
    </div>
  );
}
