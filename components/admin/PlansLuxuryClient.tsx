"use client";

/**
 * Plans & Monetization — premium pricing operations center.
 *
 * Three layers, top→bottom:
 *   1. Executive monetization KPIs (live: total subs / MRR / 30d revenue / churn)
 *   2. Pricing cards — one per plan, with Stripe sync chip, subscriber count,
 *      MRR contribution, signup sparkline, and a feature highlight list.
 *   3. Feature matrix — categorized capabilities x plan grid.
 *   4. Upgrade pressure panel — tenants near limits or value-extracting.
 *
 * Annual / monthly toggle drives the displayed price + per-plan "save N%"
 * computed from the actual DB pricing. No hardcoded discount math.
 *
 * Strict invariants:
 *   • Plan slug is immutable — edit form (linked from a footer link)
 *     keeps the existing /admin/plans/[id] route untouched.
 *   • All values from real DB queries (plans rows + per-plan intelligence).
 *   • Stripe sync chip uses real STRIPE_PRICE_ID columns. No mock IDs.
 */

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Crown,
  Loader2,
  Settings2,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";

import { AnimatedCounter } from "@/components/ui/AnimatedCounter";
import type {
  PlanIntelReport,
  StripeSyncDiagnostic,
  UpgradeCandidate,
} from "@/lib/admin-analytics/plans-intelligence";

// ─── Types ──────────────────────────────────────────────────────────

export type PlanRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  priceYearlyCents: number;
  stripePriceIdMonthly: string | null;
  stripePriceIdYearly: string | null;
  quotaStaff: number;
  quotaManagers: number;
  quotaBookingsPerMonth: number;
  quotaServices: number;
  features: string[];
  active: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

// ─── Helpers ────────────────────────────────────────────────────────

const fmtCurrency = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);

/** Price formatter. The 'free' slug renders "Free forever".
 *  Any other plan with priceMonthlyCents=0 AND priceYearlyCents=0
 *  falls back to "Custom — contact sales" (kept as a fallback for
 *  future-tier flexibility; not used by the current 5-tier strategy
 *  since Enterprise has real prices). */
function planPriceDisplay(plan: PlanRow, interval: "month" | "year"): {
  label: string;
  suffix: string;
  isCustom: boolean;
  isFree: boolean;
} {
  if (plan.slug === "free") return { label: "Free", suffix: "forever", isCustom: false, isFree: true };
  if (plan.priceMonthlyCents === 0 && plan.priceYearlyCents === 0) {
    return { label: "Custom", suffix: "contact sales", isCustom: true, isFree: false };
  }
  if (interval === "year") {
    const yearly = plan.priceYearlyCents || plan.priceMonthlyCents * 12;
    return {
      label: fmtCurrency(yearly / 12),
      suffix: "/mo, billed annually",
      isCustom: false,
      isFree: false,
    };
  }
  return {
    label: fmtCurrency(plan.priceMonthlyCents),
    suffix: "/month",
    isCustom: false,
    isFree: false,
  };
}

/** Compute % saved when paying annually vs monthly. */
function annualSavingsPct(plan: PlanRow): number | null {
  if (plan.priceMonthlyCents <= 0 || plan.priceYearlyCents <= 0) return null;
  const monthlyTotal = plan.priceMonthlyCents * 12;
  const saved = monthlyTotal - plan.priceYearlyCents;
  if (saved <= 0) return null;
  return Math.round((saved / monthlyTotal) * 100);
}

/** Limit display — "Unlimited" for -1, raw number otherwise. */
function fmtLimit(n: number): string {
  if (n === -1) return "Unlimited";
  return new Intl.NumberFormat("en-US").format(n);
}

// ─── Inline sparkline ──────────────────────────────────────────────

function Sparkline({ data, tone = "sky" }: { data: number[]; tone?: "sky" | "emerald" | "amber" }) {
  const w = 70;
  const h = 22;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : w;
  const points = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`)
    .join(" ");
  const cls = tone === "emerald" ? "text-emerald-500" : tone === "amber" ? "text-amber-500" : "text-sky-500";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={cls}
        points={points}
      />
    </svg>
  );
}

// ─── Plan card ─────────────────────────────────────────────────────

const PLAN_ACCENT: Record<string, { ring: string; gradient: string; pillBg: string }> = {
  free: {
    ring: "border-slate-200",
    gradient: "from-white to-slate-50/40",
    pillBg: "bg-slate-100 text-slate-700",
  },
  solo: {
    ring: "border-slate-200",
    gradient: "from-white to-slate-50/30",
    pillBg: "bg-slate-100 text-slate-700",
  },
  pro: {
    ring: "border-sky-300",
    gradient: "from-white via-sky-50/30 to-sky-50/60",
    pillBg: "bg-sky-100 text-sky-700",
  },
  team: {
    ring: "border-violet-200",
    gradient: "from-white to-violet-50/30",
    pillBg: "bg-violet-100 text-violet-700",
  },
  enterprise: {
    ring: "border-slate-300",
    gradient: "from-slate-900/95 to-slate-900",
    pillBg: "bg-white/10 text-white",
  },
} as const;

function StripeSyncChip({ diag }: { diag: StripeSyncDiagnostic | null }) {
  if (!diag) return null;
  if (!diag.expectsStripePrice) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200">
        No Stripe needed
      </span>
    );
  }
  if (diag.monthlyConfigured) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
        <CheckCircle2 className="h-2.5 w-2.5" />
        Stripe synced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-amber-200">
      <AlertCircle className="h-2.5 w-2.5" />
      Stripe missing
    </span>
  );
}

function PlanCard({
  plan,
  intel,
  diag,
  interval,
  isPopular,
}: {
  plan: PlanRow;
  intel: PlanIntelReport["rows"][number] | undefined;
  diag: StripeSyncDiagnostic | undefined;
  interval: "month" | "year";
  isPopular: boolean;
}) {
  const accent = PLAN_ACCENT[plan.slug] ?? PLAN_ACCENT.free;
  const price = planPriceDisplay(plan, interval);
  const savings = annualSavingsPct(plan);
  const isDark = plan.slug === "enterprise";

  return (
    <article
      className={`relative overflow-hidden rounded-2xl border bg-gradient-to-br ${accent.gradient} ${accent.ring} p-5 shadow-[0_1px_3px_rgba(15,23,42,0.06)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_12px_32px_rgba(15,23,42,0.10)]`}
    >
      {isPopular ? (
        <div className="absolute -top-px right-5 inline-flex items-center gap-1 rounded-b-md bg-gradient-to-b from-violet-600 to-violet-500 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white shadow-sm">
          <Sparkles className="h-3 w-3" />
          Most popular
        </div>
      ) : null}
      {plan.slug === "enterprise" ? (
        <div className="absolute -top-px right-5 inline-flex items-center gap-1 rounded-b-md bg-gradient-to-b from-amber-500 to-amber-400 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-950 shadow-sm">
          <Crown className="h-3 w-3" />
          Best for scale
        </div>
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <div>
          <div
            className={`text-[10px] font-medium uppercase tracking-wider ${
              isDark ? "text-slate-400" : "text-slate-500"
            }`}
          >
            {plan.slug}
          </div>
          <h3 className={`mt-0.5 text-[20px] font-semibold ${isDark ? "text-white" : "text-slate-900"}`}>
            {plan.name}
          </h3>
        </div>
        <StripeSyncChip diag={diag ?? null} />
      </div>

      {plan.description ? (
        <p className={`mt-1 text-[12px] leading-relaxed ${isDark ? "text-slate-300" : "text-slate-600"}`}>
          {plan.description}
        </p>
      ) : null}

      {/* Price */}
      <div className="mt-4 flex items-baseline gap-1">
        <div
          className={`text-[28px] font-semibold leading-none ${
            isDark ? "text-white" : "text-slate-900"
          }`}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {price.label}
        </div>
        <div className={`text-[12px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>
          {price.suffix}
        </div>
      </div>
      {interval === "year" && savings !== null ? (
        <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
          Save {savings}% annually
        </div>
      ) : null}

      {/* Live intelligence pills */}
      {intel ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div
            className={`rounded-lg p-2 ${
              isDark ? "bg-white/5" : "bg-white ring-1 ring-slate-100"
            }`}
          >
            <div
              className={`text-[10px] font-medium uppercase tracking-wider ${
                isDark ? "text-slate-400" : "text-slate-500"
              }`}
            >
              Subscribers
            </div>
            <div
              className={`mt-0.5 text-[18px] font-semibold ${isDark ? "text-white" : "text-slate-900"}`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              <AnimatedCounter value={intel.activeSubscribers} />
            </div>
            {intel.signupSparkline14d.some((v) => v > 0) ? (
              <div className="mt-1">
                <Sparkline data={intel.signupSparkline14d} tone="sky" />
              </div>
            ) : null}
          </div>
          <div
            className={`rounded-lg p-2 ${
              isDark ? "bg-white/5" : "bg-white ring-1 ring-slate-100"
            }`}
          >
            <div
              className={`text-[10px] font-medium uppercase tracking-wider ${
                isDark ? "text-slate-400" : "text-slate-500"
              }`}
            >
              Plan MRR
            </div>
            <div
              className={`mt-0.5 text-[18px] font-semibold ${isDark ? "text-white" : "text-slate-900"}`}
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {fmtCurrency(intel.estimatedMrrCents)}
            </div>
            <div className={`mt-1 text-[10px] ${isDark ? "text-slate-400" : "text-slate-500"}`}>
              {intel.trialingSubscribers > 0 ? `${intel.trialingSubscribers} trialing · ` : ""}
              {intel.pastDueSubscribers > 0 ? `${intel.pastDueSubscribers} past due` : "all current"}
            </div>
          </div>
        </div>
      ) : null}

      {/* Quotas */}
      <ul
        className={`mt-4 space-y-1.5 text-[12px] ${
          isDark ? "text-slate-200" : "text-slate-700"
        }`}
      >
        <li className="flex items-center gap-2">
          <Users className={`h-3.5 w-3.5 ${isDark ? "text-slate-400" : "text-slate-500"}`} />
          {fmtLimit(plan.quotaStaff)} staff seats
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className={`h-3.5 w-3.5 ${isDark ? "text-emerald-400" : "text-emerald-500"}`} />
          {fmtLimit(plan.quotaServices)} services
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className={`h-3.5 w-3.5 ${isDark ? "text-emerald-400" : "text-emerald-500"}`} />
          {fmtLimit(plan.quotaBookingsPerMonth)} bookings/mo
        </li>
      </ul>

      {/* Top features */}
      {plan.features.length > 0 ? (
        <ul
          className={`mt-3 space-y-1 border-t pt-3 text-[12px] ${
            isDark ? "border-white/10 text-slate-200" : "border-slate-100 text-slate-700"
          }`}
        >
          {plan.features.slice(0, 5).map((f, i) => (
            <li key={i} className="flex items-start gap-2">
              <CheckCircle2
                className={`mt-0.5 h-3 w-3 shrink-0 ${
                  isDark ? "text-emerald-400" : "text-emerald-500"
                }`}
              />
              <span>{f}</span>
            </li>
          ))}
          {plan.features.length > 5 ? (
            <li className={`text-[11px] italic ${isDark ? "text-slate-400" : "text-slate-500"}`}>
              + {plan.features.length - 5} more
            </li>
          ) : null}
        </ul>
      ) : null}

      {/* Footer — edit link + stripe link */}
      <div
        className={`mt-4 flex items-center justify-between border-t pt-3 text-[11px] ${
          isDark ? "border-white/10" : "border-slate-100"
        }`}
      >
        <Link
          href={`/admin/plans/${plan.id}`}
          className={`inline-flex items-center gap-1 ${
            isDark
              ? "text-slate-300 hover:text-white"
              : "text-slate-600 hover:text-slate-900"
          }`}
        >
          <Settings2 className="h-3 w-3" />
          Edit limits
        </Link>
        {diag?.monthlyPriceId ? (
          <a
            href={`https://dashboard.stripe.com/prices/${diag.monthlyPriceId}`}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1 ${
              isDark ? "text-slate-300 hover:text-white" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Open in Stripe →
          </a>
        ) : null}
      </div>
    </article>
  );
}

// ─── KPI row ───────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "neutral" | "growth" | "warning";
}) {
  const ring = tone === "growth" ? "ring-emerald-200" : tone === "warning" ? "ring-amber-200" : "ring-slate-200";
  return (
    <div className={`rounded-xl bg-white p-4 ring-1 shadow-[0_1px_2px_rgba(15,23,42,0.04)] ${ring}`}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-[24px] font-semibold leading-none text-slate-900" style={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-slate-500">{hint}</div> : null}
    </div>
  );
}

// ─── Feature matrix ────────────────────────────────────────────────

type FeatureCategory = {
  label: string;
  rows: Array<{
    feature: string;
    /** Per-plan support: true | false | "unlimited" | string for nuanced text. */
    perPlan: Record<string, boolean | string>;
  }>;
};

function buildFeatureMatrix(plans: PlanRow[]): FeatureCategory[] {
  return [
    {
      label: "Scheduling",
      rows: [
        {
          feature: "Public booking page",
          perPlan: { free: true, solo: true, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Active services",
          perPlan: Object.fromEntries(plans.map((p) => [p.slug, fmtLimit(p.quotaServices)])),
        },
        {
          feature: "Bookings per month",
          perPlan: Object.fromEntries(plans.map((p) => [p.slug, fmtLimit(p.quotaBookingsPerMonth)])),
        },
        {
          feature: "Embed widget",
          perPlan: { free: false, solo: true, pro: true, team: true, enterprise: true },
        },
      ],
    },
    {
      label: "Team & Management",
      rows: [
        {
          feature: "Staff seats",
          perPlan: Object.fromEntries(plans.map((p) => [p.slug, fmtLimit(p.quotaStaff)])),
        },
        {
          feature: "Manager seats",
          perPlan: Object.fromEntries(plans.map((p) => [p.slug, fmtLimit(p.quotaManagers)])),
        },
        {
          feature: "Departments + routing",
          perPlan: { free: false, solo: false, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Admin role overrides",
          perPlan: { free: false, solo: false, pro: false, team: true, enterprise: true },
        },
      ],
    },
    {
      label: "Integrations",
      rows: [
        {
          feature: "Google Calendar",
          perPlan: { free: true, solo: true, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Microsoft 365 + Outlook",
          perPlan: { free: false, solo: true, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Google Meet",
          perPlan: { free: true, solo: true, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Zoom",
          perPlan: { free: false, solo: true, pro: true, team: true, enterprise: true },
        },
      ],
    },
    {
      label: "Branding & Domain",
      rows: [
        {
          feature: "Branding removal",
          perPlan: { free: false, solo: true, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Custom domain",
          perPlan: { free: false, solo: true, pro: true, team: true, enterprise: true },
        },
        {
          feature: "White-label",
          perPlan: { free: false, solo: false, pro: false, team: false, enterprise: true },
        },
      ],
    },
    {
      label: "Automation & Analytics",
      rows: [
        {
          feature: "Analytics access",
          perPlan: { free: false, solo: true, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Executive dashboard",
          perPlan: { free: false, solo: false, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Reports center",
          perPlan: { free: false, solo: false, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Reminder automations",
          perPlan: { free: false, solo: false, pro: true, team: true, enterprise: true },
        },
        {
          feature: "Advanced reporting",
          perPlan: { free: false, solo: false, pro: false, team: true, enterprise: true },
        },
      ],
    },
    {
      label: "Enterprise",
      rows: [
        {
          feature: "SSO / SAML",
          perPlan: { free: false, solo: false, pro: false, team: false, enterprise: true },
        },
        {
          feature: "Enterprise SLA",
          perPlan: { free: false, solo: false, pro: false, team: false, enterprise: true },
        },
        {
          feature: "Priority support",
          perPlan: { free: false, solo: false, pro: false, team: true, enterprise: true },
        },
        {
          feature: "Audit + governance exports",
          perPlan: { free: false, solo: false, pro: false, team: false, enterprise: true },
        },
        {
          feature: "Dedicated onboarding",
          perPlan: { free: false, solo: false, pro: false, team: false, enterprise: true },
        },
      ],
    },
  ];
}

function FeatureCell({ value }: { value: boolean | string | undefined }) {
  if (value === true) return <CheckCircle2 className="mx-auto h-4 w-4 text-emerald-600" />;
  if (value === false || value === undefined) return <span className="text-slate-300">—</span>;
  return <span className="text-[12px] font-medium text-slate-700">{value}</span>;
}

// ─── Upgrade pressure panel ────────────────────────────────────────

function UpgradePressurePanel({ candidates }: { candidates: UpgradeCandidate[] }) {
  if (candidates.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/40 px-4 py-6 text-center text-[12px] text-slate-500">
        No high-pressure upgrade candidates right now. Free/Pro tenants are not yet hitting limits.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/30 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="border-b border-amber-200 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-amber-900">
          <Zap className="h-3.5 w-3.5 text-amber-600" />
          Top upgrade candidates
        </div>
        <div className="text-[11px] text-amber-700">
          Free/Pro tenants with high booking volume — value extraction on lower tier
        </div>
      </div>
      <ul>
        {candidates.map((c) => (
          <li
            key={c.tenantId}
            className="flex items-center justify-between gap-3 border-b border-amber-200 px-4 py-2.5 last:border-b-0 hover:bg-amber-50/40"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="h-2 w-2 rounded-full bg-amber-500" />
              <Link
                href={`/admin/tenants/${c.tenantId}`}
                className="truncate text-[13px] font-medium text-slate-900 hover:underline"
              >
                {c.tenantName}
              </Link>
              <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-600 ring-1 ring-slate-200">
                {c.currentPlan}
              </span>
            </div>
            <span className="text-[12px] text-slate-700">{c.pressureSignal}</span>
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-amber-100">
              <div
                className="h-full bg-amber-500"
                style={{ width: `${Math.round(c.pressureScore * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Top-level client ─────────────────────────────────────────────

export default function PlansLuxuryClient({
  initialPlans,
  intel,
  diagnostics,
  candidates,
}: {
  initialPlans: PlanRow[];
  intel: PlanIntelReport | null;
  diagnostics: StripeSyncDiagnostic[];
  candidates: UpgradeCandidate[];
}) {
  const [interval, setInterval] = React.useState<"month" | "year">("month");

  const planBySlug = React.useMemo(() => {
    const m = new Map<string, PlanRow>();
    for (const p of initialPlans) m.set(p.slug, p);
    return m;
  }, [initialPlans]);

  const intelBySlug = React.useMemo(() => {
    const m = new Map<string, PlanIntelReport["rows"][number]>();
    if (intel) for (const r of intel.rows) m.set(r.slug, r);
    return m;
  }, [intel]);

  const diagBySlug = React.useMemo(() => {
    const m = new Map<string, StripeSyncDiagnostic>();
    for (const d of diagnostics) m.set(d.slug, d);
    return m;
  }, [diagnostics]);

  // ARR projection from current MRR.
  const arrCents = intel ? intel.totals.estimatedMrrCents * 12 : 0;

  return (
    <div className="space-y-6">
      {/* Sticky executive header */}
      <div className="sticky top-0 z-10 -mx-2 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/95 px-3 py-2.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-900">Plans & Monetization</div>
            <div className="text-[11px] text-slate-500">
              {intel ? (
                <>
                  Computed in {intel.computedInMs}ms · live MRR{" "}
                  <span className="font-medium text-emerald-700">{fmtCurrency(intel.totals.estimatedMrrCents)}</span>
                </>
              ) : (
                "Loading…"
              )}
            </div>
          </div>
        </div>

        {/* Interval toggle */}
        <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-0.5 text-[12px] font-medium">
          <button
            type="button"
            onClick={() => setInterval("month")}
            className={`rounded px-3 py-1 transition-all ${
              interval === "month" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setInterval("year")}
            className={`rounded px-3 py-1 transition-all ${
              interval === "year" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            Annual <span className="ml-0.5 inline-flex items-center rounded-full bg-emerald-100 px-1 text-[10px] text-emerald-700">save</span>
          </button>
        </div>
      </div>

      {/* Executive KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Active subscribers"
          value={<AnimatedCounter value={intel?.totals.activeSubscribers ?? 0} />}
          hint={`across ${initialPlans.filter((p) => p.active).length} plans`}
        />
        <KpiTile
          label="Total MRR"
          value={fmtCurrency(intel?.totals.estimatedMrrCents ?? 0)}
          hint="subscribers × plan price"
          tone="growth"
        />
        <KpiTile
          label="ARR projection"
          value={fmtCurrency(arrCents)}
          hint="MRR × 12"
          tone="growth"
        />
        <KpiTile
          label="Churn (30d)"
          value={<AnimatedCounter value={intel?.totals.churn30d ?? 0} />}
          hint="cancel + downgrade events"
          tone={intel && intel.totals.churn30d > 0 ? "warning" : "neutral"}
        />
      </div>

      {/* Pricing cards */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Pricing</h2>
          <span className="text-[11px] text-slate-400">{interval === "month" ? "Monthly billing" : "Annual billing — pay yearly, save"}</span>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {initialPlans
            .filter((p) => p.active)
            .map((p) => (
              <PlanCard
                key={p.id}
                plan={p}
                intel={intelBySlug.get(p.slug)}
                diag={diagBySlug.get(p.slug)}
                interval={interval}
                isPopular={p.slug === "pro"}
              />
            ))}
        </div>
      </section>

      {/* Upgrade pressure */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <Zap className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Upgrade pressure</h2>
        </div>
        <UpgradePressurePanel candidates={candidates} />
      </section>

      {/* Feature matrix */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-slate-500" />
          <h2 className="text-sm font-medium text-slate-900">Feature matrix</h2>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <table className="w-full">
            <thead className="sticky top-0 bg-slate-50/80 backdrop-blur-sm">
              <tr>
                <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-slate-500">
                  Capability
                </th>
                {initialPlans.filter((p) => p.active).map((p) => (
                  <th
                    key={p.slug}
                    className="px-3 py-2.5 text-center text-[11px] font-medium uppercase tracking-wider text-slate-500"
                  >
                    {p.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buildFeatureMatrix(initialPlans).map((cat) => (
                <React.Fragment key={cat.label}>
                  <tr className="bg-slate-50/40">
                    <td
                      colSpan={initialPlans.length + 1}
                      className="border-t border-slate-100 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600"
                    >
                      {cat.label}
                    </td>
                  </tr>
                  {cat.rows.map((row, i) => (
                    <tr key={i} className="border-t border-slate-100 text-[12px] hover:bg-slate-50/40">
                      <td className="px-4 py-2 text-slate-700">{row.feature}</td>
                      {initialPlans.filter((p) => p.active).map((p) => (
                        <td key={p.slug} className="px-3 py-2 text-center">
                          <FeatureCell value={row.perPlan[p.slug]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Editor footnote */}
      <div className="text-[11px] text-slate-500">
        Plan slugs are immutable. To adjust limits or Stripe price IDs, click "Edit limits" on any
        card. Pricing changes affect new checkouts only — existing subscriptions keep their original
        Stripe Price ID.
      </div>
    </div>
  );
}
