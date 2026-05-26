"use client";

/**
 * Operations Intelligence — Executive Command Center.
 *
 * Same deterministic rule-engine substrate as before, now wrapped in a
 * premium executive experience:
 *
 *   • IntelligenceMissionHero — 7-tile composite KPI strip + posture rail
 *   • Premium insight cards with severity rail, gradient surfaces,
 *     confidence ring, priority badge, momentum/effort metadata
 *   • Investigation drawer (click any insight) with timeline,
 *     supporting data, impacted tenants, recommendations, deep-links
 *   • Recommendation queue upgraded to "Executive recommendations
 *     center" with priority rank, impact, effort, momentum
 *   • Section-level insight chips for contextual storytelling
 *
 * Engine remains DETERMINISTIC. No LLM. No hallucinations. Every
 * tile/score derives from the same SQL-backed rule report.
 */

import * as React from "react";
import {
  AlertTriangle,
  Brain,
  ChevronRight,
  Clock,
  CreditCard,
  Database,
  ExternalLink,
  Eye,
  Filter,
  Heart,
  Lightbulb,
  ListChecks,
  Loader2,
  Megaphone,
  RefreshCw,
  Shield,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
  UserMinus,
  Users,
  X,
  Zap,
} from "lucide-react";

import type {
  ImpactedTenant,
  Insight,
  InsightCategory,
  InsightSeverity,
  IntelligenceReport,
} from "@/lib/admin-analytics/intelligence";
import type { InsightImpact } from "@/lib/admin-analytics/intelligence-mission";
import {
  deriveIntelligenceMission,
  deriveInsightImpact,
} from "@/lib/admin-analytics/intelligence-mission";
import IntelligenceMissionHero from "@/components/admin/IntelligenceMissionHero";

// ─── Tone tokens ──────────────────────────────────────────────────

const SEVERITY_TONE: Record<
  InsightSeverity,
  {
    ring: string;
    chip: string;
    dot: string;
    rail: string;
    headerGradient: string;
    label: string;
  }
> = {
  critical: {
    ring: "border-rose-200 bg-gradient-to-br from-white to-rose-50/40 shadow-[0_0_0_1px_rgba(244,63,94,0.06)]",
    chip: "bg-rose-100 text-rose-800",
    dot: "bg-rose-500",
    rail: "before:bg-rose-500/80",
    headerGradient: "from-rose-50/60 via-white to-white",
    label: "Critical",
  },
  warning: {
    ring: "border-amber-200 bg-gradient-to-br from-white to-amber-50/40",
    chip: "bg-amber-100 text-amber-800",
    dot: "bg-amber-500",
    rail: "before:bg-amber-400/70",
    headerGradient: "from-amber-50/50 via-white to-white",
    label: "Warning",
  },
  opportunity: {
    ring: "border-emerald-200 bg-gradient-to-br from-white to-emerald-50/40",
    chip: "bg-emerald-100 text-emerald-800",
    dot: "bg-emerald-500",
    rail: "before:bg-emerald-400/70",
    headerGradient: "from-emerald-50/50 via-white to-white",
    label: "Opportunity",
  },
  info: {
    ring: "border-slate-200 bg-gradient-to-br from-white to-slate-50/30",
    chip: "bg-slate-100 text-slate-700",
    dot: "bg-slate-400",
    rail: "before:bg-slate-300/70",
    headerGradient: "from-slate-50/80 via-white to-white",
    label: "Info",
  },
};

const CATEGORY_VISUAL: Record<
  InsightCategory,
  { Icon: React.ComponentType<{ className?: string }>; tint: string; iconColor: string; label: string }
> = {
  growth: {
    Icon: TrendingUp,
    tint: "bg-emerald-50 ring-emerald-200",
    iconColor: "text-emerald-600",
    label: "Growth",
  },
  churn: {
    Icon: UserMinus,
    tint: "bg-rose-50 ring-rose-200",
    iconColor: "text-rose-600",
    label: "Churn",
  },
  financial: {
    Icon: CreditCard,
    tint: "bg-violet-50 ring-violet-200",
    iconColor: "text-violet-600",
    label: "Financial",
  },
  onboarding: {
    Icon: ListChecks,
    tint: "bg-sky-50 ring-sky-200",
    iconColor: "text-sky-600",
    label: "Onboarding",
  },
  infrastructure: {
    Icon: Database,
    tint: "bg-slate-100 ring-slate-300",
    iconColor: "text-slate-600",
    label: "Infrastructure",
  },
  security: {
    Icon: Shield,
    tint: "bg-orange-50 ring-orange-200",
    iconColor: "text-orange-600",
    label: "Security",
  },
  operations: {
    Icon: Heart,
    tint: "bg-sky-50 ring-sky-200",
    iconColor: "text-sky-600",
    label: "Operations",
  },
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

// ─── Confidence ring (tiny) ───────────────────────────────────────

function ConfidenceRing({ pct }: { pct: number }) {
  const radius = 10;
  const stroke = 2;
  const norm = radius - stroke / 2;
  const circ = 2 * Math.PI * norm;
  const fill = Math.max(0, Math.min(100, pct)) / 100;
  const dash = `${circ * fill} ${circ}`;
  const tone =
    pct >= 90 ? "stroke-emerald-500" : pct >= 70 ? "stroke-sky-500" : "stroke-amber-500";
  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={radius * 2 + 2} height={radius * 2 + 2} className="-rotate-90">
        <circle
          cx={radius + 1}
          cy={radius + 1}
          r={norm}
          fill="none"
          strokeWidth={stroke}
          className="stroke-slate-100"
        />
        <circle
          cx={radius + 1}
          cy={radius + 1}
          r={norm}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={dash}
          className={`${tone} transition-all duration-500`}
        />
      </svg>
      <span className="absolute text-[8px] font-semibold tabular-nums text-slate-700">{pct}</span>
    </div>
  );
}

// ─── Insight card (premium) ───────────────────────────────────────

function InsightCard({
  insight,
  onOpen,
}: {
  insight: Insight;
  onOpen: (i: Insight) => void;
}) {
  const tone = SEVERITY_TONE[insight.severity];
  const cat = CATEGORY_VISUAL[insight.category];
  const impact = deriveInsightImpact(insight);
  const momentumIcon =
    impact.momentum === "down" ? TrendingDown : impact.momentum === "up" ? TrendingUp : Sparkles;

  return (
    <button
      type="button"
      onClick={() => onOpen(insight)}
      className={`group relative overflow-hidden rounded-2xl border p-4 pl-5 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_8px_24px_rgba(15,23,42,0.08)] before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${tone.ring} ${tone.rail}`}
    >
      <header className="flex items-start gap-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${cat.tint}`}
        >
          <cat.Icon className={`h-4 w-4 ${cat.iconColor}`} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone.chip}`}
            >
              <span className={`inline-flex h-1.5 w-1.5 rounded-full ${tone.dot}`} />
              {tone.label}
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
              {cat.label}
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
              <ConfidenceRing pct={insight.confidence} />
              confidence
            </span>
          </div>
          <h3 className="mt-1.5 text-[14px] font-semibold tracking-tight text-slate-900">
            {insight.title}
          </h3>
          <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-slate-600">
            {insight.explanation}
          </p>
        </div>
      </header>

      {/* Footer meta */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium ${
            impact.priority === 1
              ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
              : impact.priority === 2
              ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
              : "bg-slate-100 text-slate-600"
          }`}
        >
          P{impact.priority}
        </span>
        <span className="inline-flex items-center gap-1 text-slate-500">
          <Users className="h-2.5 w-2.5" />
          {impact.tenantCount === 0
            ? "no tenants"
            : `${impact.tenantCount} tenant${impact.tenantCount === 1 ? "" : "s"}`}
        </span>
        <span className="inline-flex items-center gap-1 text-slate-500">
          <Zap className="h-2.5 w-2.5" />
          {impact.effort} effort
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-slate-400 group-hover:text-slate-600">
          {React.createElement(momentumIcon, { className: "h-2.5 w-2.5" })}
          investigate
          <ChevronRight className="h-2.5 w-2.5 group-hover:translate-x-0.5" />
        </span>
      </div>
    </button>
  );
}

// ─── Investigation drawer ─────────────────────────────────────────

function InvestigationDrawer({
  insight,
  onClose,
}: {
  insight: Insight | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!insight) return null;
  const tone = SEVERITY_TONE[insight.severity];
  const cat = CATEGORY_VISUAL[insight.category];
  const impact = deriveInsightImpact(insight);

  // Deep-link routing based on category.
  const quickLinks: Array<{ href: string; label: string; Icon: React.ComponentType<{ className?: string }> }> = [
    { href: "/admin/intelligence-tenants", label: "Tenant intelligence", Icon: Users },
  ];
  if (insight.category === "financial") {
    quickLinks.push({ href: "/admin/finance", label: "Finance ops", Icon: CreditCard });
  }
  if (insight.category === "infrastructure" || insight.category === "operations") {
    quickLinks.push({ href: "/admin/diagnostics", label: "Diagnostics", Icon: ShieldCheck });
  }
  if (insight.category === "security") {
    quickLinks.push({ href: "/admin/security", label: "Security ops", Icon: Shield });
  }
  if (insight.category === "growth" || insight.category === "onboarding") {
    quickLinks.push({ href: "/admin/promotions", label: "Launch promotion", Icon: Sparkles });
    quickLinks.push({ href: "/admin/announcements", label: "Send announcement", Icon: Megaphone });
  }
  quickLinks.push({ href: "/admin/activity", label: "Open activity feed", Icon: Clock });

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
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone.chip}`}
                >
                  <span className={`inline-flex h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                  {tone.label}
                </span>
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${cat.tint} ${cat.iconColor}`}
                >
                  <cat.Icon className="h-2.5 w-2.5" />
                  {cat.label}
                </span>
                <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
                  <ConfidenceRing pct={insight.confidence} />
                  {insight.confidence}% confidence
                </span>
              </div>
              <h2 className="mt-2 text-base font-semibold tracking-tight text-slate-900">
                {insight.title}
              </h2>
              <div className="mt-1 text-[12px] text-slate-500">
                Generated {timeAgo(insight.generatedAt)} · rule kind{" "}
                <code className="text-[11px]">{insight.kind}</code>
              </div>
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
          {/* Strategic impact summary */}
          <Section title="Strategic impact">
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              <ImpactPill label="Priority" value={`P${impact.priority}`} tone={impact.priority === 1 ? "critical" : impact.priority === 2 ? "warning" : "neutral"} />
              <ImpactPill
                label="Tenants"
                value={impact.tenantCount === 0 ? "—" : String(impact.tenantCount)}
                tone="neutral"
              />
              <ImpactPill label="Effort" value={impact.effort} tone="neutral" />
            </div>
          </Section>

          <Section title="Explanation">
            <p className="text-[13px] leading-relaxed text-slate-700">{insight.explanation}</p>
          </Section>

          {Object.keys(insight.supportingData).length > 0 ? (
            <Section title="Supporting SQL metrics">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(insight.supportingData).map(([k, v]) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50/60 px-2 py-1 text-[11px]"
                  >
                    <span className="text-slate-500">{k.replace(/_/g, " ")}:</span>
                    <span className="font-mono font-semibold text-slate-800">{String(v)}</span>
                  </span>
                ))}
              </div>
            </Section>
          ) : null}

          {insight.impactedTenants.length > 0 ? (
            <Section title={`Impacted tenants (${insight.impactedTenants.length})`}>
              <ul className="space-y-1">
                {insight.impactedTenants.map((t) => (
                  <ImpactedTenantRow key={t.id} tenant={t} />
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="Recommended actions">
            <ul className="space-y-2 text-[13px] text-slate-700">
              {insight.recommendedActions.map((a, i) => (
                <li key={i} className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50/30 px-3 py-2">
                  <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <span>{a}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Quick actions">
            <div className="grid grid-cols-2 gap-2">
              {quickLinks.map((l) => (
                <DrawerLink key={l.label} href={l.href} label={l.label} Icon={l.Icon} />
              ))}
            </div>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-slate-500">
        {title}
      </div>
      <div>{children}</div>
    </section>
  );
}

function ImpactPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "critical" | "warning" | "neutral";
}) {
  const cls =
    tone === "critical"
      ? "border-rose-200 bg-rose-50/40 text-rose-900"
      : tone === "warning"
      ? "border-amber-200 bg-amber-50/40 text-amber-900"
      : "border-slate-200 bg-slate-50/60 text-slate-800";
  return (
    <div className={`rounded-lg border px-3 py-2 ${cls}`}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 text-[14px] font-semibold capitalize">{value}</div>
    </div>
  );
}

function ImpactedTenantRow({ tenant }: { tenant: ImpactedTenant }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[12px] transition-colors hover:bg-slate-50/40">
      <a href={`/admin/tenants/${tenant.id}`} className="flex-1 truncate text-sky-700 hover:underline">
        {tenant.name}
      </a>
      <span className="truncate text-[11px] text-slate-500">{tenant.detail}</span>
      <ExternalLink className="h-3 w-3 text-slate-300" />
    </li>
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

// ─── Section group ────────────────────────────────────────────────

function SectionGroup({
  title,
  icon: Icon,
  insights,
  emptyText,
  onOpen,
  storytellingChip,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  insights: Insight[];
  emptyText: string;
  onOpen: (i: Insight) => void;
  storytellingChip?: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <Icon className="h-3.5 w-3.5 text-slate-500" />
        <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">{title}</h2>
        <span className="text-[11px] text-slate-400">{insights.length}</span>
        {storytellingChip ? <div className="ml-2">{storytellingChip}</div> : null}
      </div>
      {insights.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-gradient-to-br from-slate-50/40 to-white px-4 py-10 text-center text-[12px] text-slate-500">
          {emptyText}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {insights.map((i) => (
            <InsightCard key={i.id} insight={i} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Storytelling chip (deterministic, surface-routed) ────────────

function StorytellingChip({
  tone,
  label,
  detail,
}: {
  tone: "positive" | "warning" | "critical" | "neutral";
  label: string;
  detail: string;
}) {
  const styles =
    tone === "positive"
      ? "bg-emerald-50/60 ring-emerald-200 text-emerald-900"
      : tone === "warning"
      ? "bg-amber-50/60 ring-amber-200 text-amber-900"
      : tone === "critical"
      ? "bg-rose-50/60 ring-rose-200 text-rose-900"
      : "bg-slate-50/60 ring-slate-200 text-slate-800";
  const Icon = tone === "positive" ? TrendingUp : tone === "critical" ? AlertTriangle : Sparkles;
  return (
    <span
      title={detail}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${styles}`}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

// ─── Premium recommendation queue ─────────────────────────────────

function RecommendationsQueue({
  insights,
  onOpen,
}: {
  insights: Insight[];
  onOpen: (i: Insight) => void;
}) {
  // Flatten recommended actions, ranked by insight priority/severity.
  const items = insights
    .flatMap((i) =>
      i.recommendedActions.map((a, idx) => ({
        key: `${i.id}:${idx}`,
        insight: i,
        action: a,
        impact: deriveInsightImpact(i),
      })),
    )
    .sort((a, b) => a.impact.priority - b.impact.priority);

  if (items.length === 0) {
    return (
      <section>
        <div className="mb-3 flex items-baseline gap-2">
          <ListChecks className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
            Executive recommendations
          </h2>
        </div>
        <div className="rounded-2xl border border-dashed border-emerald-200/70 bg-gradient-to-br from-emerald-50/30 via-white to-white px-6 py-12 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-200/60">
            <ListChecks className="h-6 w-6 text-emerald-500" />
          </div>
          <div className="mt-3 text-sm font-semibold text-slate-900">
            No active recommendations
          </div>
          <div className="mt-1 max-w-md mx-auto text-[12px] leading-snug text-slate-500">
            Rules engine is quiet across all 14 deterministic checks. New
            recommendations will surface when a rule trips its threshold.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <ListChecks className="h-3.5 w-3.5 text-slate-500" />
        <h2 className="text-[15px] font-semibold tracking-tight text-slate-900">
          Executive recommendations
        </h2>
        <span className="text-[11px] text-slate-400">{items.length} prioritized</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <ul>
          {items.map((it) => {
            const tone = SEVERITY_TONE[it.insight.severity];
            const cat = CATEGORY_VISUAL[it.insight.category];
            return (
              <li
                key={it.key}
                className={`relative flex items-start gap-3 border-b border-slate-100 px-4 py-3 pl-5 transition-colors last:border-b-0 hover:bg-slate-50/40 before:absolute before:left-0 before:top-0 before:h-full before:w-[3px] ${tone.rail}`}
              >
                <span
                  className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ring-1 ${
                    it.impact.priority === 1
                      ? "bg-rose-50 text-rose-700 ring-rose-200"
                      : it.impact.priority === 2
                      ? "bg-amber-50 text-amber-700 ring-amber-200"
                      : "bg-slate-50 text-slate-600 ring-slate-200"
                  }`}
                >
                  P{it.impact.priority}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-slate-900">{it.action}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tone.chip}`}
                    >
                      {tone.label}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${cat.tint} ${cat.iconColor}`}
                    >
                      <cat.Icon className="h-2.5 w-2.5" />
                      {cat.label}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-2.5 w-2.5" />
                      {it.impact.tenantCount === 0
                        ? "no tenants"
                        : `${it.impact.tenantCount} tenant${it.impact.tenantCount === 1 ? "" : "s"}`}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Zap className="h-2.5 w-2.5" />
                      {it.impact.effort} effort
                    </span>
                    <span className="truncate text-slate-400">· {it.insight.title}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpen(it.insight)}
                  className="ml-2 inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Eye className="h-3 w-3" />
                  Investigate
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────

function Footer() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50/40 to-white px-5 py-4 text-[11px] text-slate-500">
      <div className="flex items-center gap-1.5 font-semibold text-slate-700">
        <Brain className="h-3 w-3" />
        How this works
      </div>
      <p className="mt-1 leading-relaxed">
        Every insight, score, and tile on this page is generated by a deterministic SQL rule
        engine. There is <strong>no LLM</strong>, no machine learning, no inferred labels. Each
        insight's explanation, supporting data, and impacted tenants come from real DB queries
        against the tables noted in the explanation text. Mission KPIs are pure composites of those
        same insights. Refresh cadence: 2 minutes; cache TTL: 2 minutes.
      </p>
    </div>
  );
}

// ─── Top-level client ────────────────────────────────────────────

export default function IntelligenceClient({ initial }: { initial: IntelligenceReport | null }) {
  const [report, setReport] = React.useState<IntelligenceReport | null>(initial);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshAt, setLastRefreshAt] = React.useState(Date.now());
  const [drawerInsight, setDrawerInsight] = React.useState<Insight | null>(null);

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
        <div className="h-[160px] animate-pulse rounded-2xl border border-slate-200 bg-slate-50/50" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[120px] animate-pulse rounded-2xl border border-slate-200 bg-slate-50/50" />
        ))}
      </div>
    );
  }

  // Derive mission composite from the rule report — DETERMINISTIC.
  const mission = deriveIntelligenceMission(report);

  const all = report.insights;
  const critical = all.filter((i) => i.severity === "critical");
  const opportunities = all.filter((i) => i.severity === "opportunity");
  const churn = all.filter((i) => i.category === "churn");
  const infra = all.filter((i) => i.category === "infrastructure");
  const financial = all.filter((i) => i.category === "financial");
  const operations = all.filter((i) => i.category === "operations");

  // Storytelling chips — deterministic from mission scores.
  const churnChip =
    mission.churnPressure !== null && mission.churnPressure >= 20 ? (
      <StorytellingChip
        tone={mission.churnPressure >= 40 ? "critical" : "warning"}
        label={`Churn pressure ${mission.churnPressure} — review queue`}
        detail="Composite of churn-risk + onboarding-dropoff signal weight."
      />
    ) : null;
  const growthChip =
    mission.strategicOpportunity !== null && mission.strategicOpportunity >= 40 ? (
      <StorytellingChip
        tone="positive"
        label={`Strategic opportunity score ${mission.strategicOpportunity}`}
        detail="Opportunity-severity insights + upgrade + high-growth weight."
      />
    ) : null;
  const infraChip =
    mission.operationalAnomaly !== null && mission.operationalAnomaly >= 20 ? (
      <StorytellingChip
        tone={mission.operationalAnomaly >= 40 ? "critical" : "warning"}
        label={`Operational anomaly score ${mission.operationalAnomaly}`}
        detail="Composite of infrastructure + operations signal weight."
      />
    ) : null;

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

      {/* Sticky topbar */}
      <div className="sticky top-0 z-10 -mx-2 flex items-center justify-between rounded-2xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2.5">
          <span className="relative inline-flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-500 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-500" />
          </span>
          <div>
            <div className="text-[13px] font-semibold tracking-tight text-slate-900">
              Operations Intelligence
            </div>
            <div className="text-[11px] text-slate-500">
              Deterministic rule engine · refresh every 2m · last{" "}
              {timeAgo(new Date(lastRefreshAt).toISOString())}
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

      {/* Executive mission hero */}
      <IntelligenceMissionHero kpis={mission} computedInMs={report.computedInMs} />

      <SectionGroup
        title="Critical alerts"
        icon={AlertTriangle}
        insights={critical}
        emptyText="No critical alerts. Threshold-based critical rules quiet across infra, finance, churn, and security."
        onOpen={setDrawerInsight}
      />

      <SectionGroup
        title="Growth opportunities"
        icon={Sparkles}
        insights={opportunities}
        emptyText="No growth-flagged insights right now. Engine is monitoring signup velocity, expansion patterns, and upgrade candidates."
        onOpen={setDrawerInsight}
        storytellingChip={growthChip}
      />

      <SectionGroup
        title="Churn risks"
        icon={UserMinus}
        insights={churn}
        emptyText="No churn signals tripped today. Inactive-tenant + activity-drop rules are clean."
        onOpen={setDrawerInsight}
        storytellingChip={churnChip}
      />

      <SectionGroup
        title="Infrastructure warnings"
        icon={Database}
        insights={infra}
        emptyText="Infra rules are quiet — webhook + reminder + sync error ratios all under thresholds."
        onOpen={setDrawerInsight}
        storytellingChip={infraChip}
      />

      <SectionGroup
        title="Financial risks & opportunities"
        icon={CreditCard}
        insights={financial}
        emptyText="No financial-rule signals. Dunning + upgrade-candidate rules are quiet."
        onOpen={setDrawerInsight}
      />

      <SectionGroup
        title="Trend & seasonal analysis"
        icon={TrendingUp}
        insights={operations}
        emptyText="Booking volume is tracking normal weekday baselines."
        onOpen={setDrawerInsight}
      />

      <RecommendationsQueue insights={all} onOpen={setDrawerInsight} />

      <Footer />

      <InvestigationDrawer insight={drawerInsight} onClose={() => setDrawerInsight(null)} />
    </div>
  );
}
