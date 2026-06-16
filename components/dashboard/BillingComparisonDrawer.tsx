/**
 * BillingComparisonDrawer — Phase 16A.
 *
 * A standalone client component that renders:
 *   - A button "Compare full features" inside a premium card
 *   - When clicked, a Drawer (size="xl") opens with the full feature
 *     matrix across all 5 tiers
 *
 * Pure presentation. Doesn't touch billing state, doesn't make API
 * calls. The drawer table content is hardcoded (additive — derived
 * from the Phase 16A spec). It stays in sync with the `Plan.features`
 * marketing bullets by including every row a reasonable buyer would
 * want to verify before upgrading.
 */
"use client";

import * as React from "react";
import { Drawer } from "@/components/ui/primitives";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";
import {
  ArrowRight,
  CheckCircle2,
  Layers,
  Lock,
  Minus,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

type PlanColumnId = "free" | "solo" | "pro" | "team" | "enterprise";

type Row =
  | {
      kind: "section";
      label: string;
    }
  | {
      kind: "feature";
      label: string;
      values: Record<PlanColumnId, string | "yes" | "no" | "soon">;
    };

// Matrix rows — grouped into 5 sections so the table reads cleanly on
// every viewport. Each value is either a literal limit ("3 seats",
// "Unlimited") or one of the three sentinel keywords.
const ROWS: Row[] = [
  { kind: "section", label: "Capacity" },
  {
    kind: "feature",
    label: "Staff seats",
    values: { free: "1", solo: "1", pro: "3", team: "10", enterprise: "Unlimited" },
  },
  {
    kind: "feature",
    label: "Manager seats",
    values: { free: "0", solo: "0", pro: "1", team: "1", enterprise: "Unlimited" },
  },
  {
    kind: "feature",
    label: "Active services",
    values: { free: "3", solo: "Unlimited", pro: "Unlimited", team: "Unlimited", enterprise: "Unlimited" },
  },
  {
    kind: "feature",
    label: "Bookings per month",
    values: { free: "Unlimited", solo: "Unlimited", pro: "Unlimited", team: "Unlimited", enterprise: "Unlimited" },
  },

  { kind: "section", label: "Branding & experience" },
  {
    kind: "feature",
    label: "Public booking page",
    values: { free: "yes", solo: "yes", pro: "yes", team: "yes", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Branding removal",
    values: { free: "no", solo: "yes", pro: "yes", team: "yes", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Advanced branding",
    values: { free: "no", solo: "no", pro: "yes", team: "yes", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Custom domain",
    values: { free: "no", solo: "no", pro: "yes", team: "yes", enterprise: "yes" },
  },

  { kind: "section", label: "Intelligence" },
  {
    kind: "feature",
    label: "Analytics access",
    values: { free: "no", solo: "yes", pro: "yes", team: "yes", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Executive dashboard",
    values: { free: "no", solo: "no", pro: "yes", team: "yes", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Reports center",
    values: { free: "no", solo: "Basic", pro: "Full", team: "Advanced", enterprise: "Advanced" },
  },
  {
    kind: "feature",
    label: "Communications command center",
    values: { free: "no", solo: "no", pro: "yes", team: "yes", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Reminder automations",
    values: { free: "Basic", solo: "Basic", pro: "Advanced", team: "Advanced", enterprise: "Advanced" },
  },

  { kind: "section", label: "Operations" },
  {
    kind: "feature",
    label: "Audit history",
    values: { free: "no", solo: "no", pro: "no", team: "yes", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Export center",
    values: { free: "no", solo: "Basic", pro: "Basic", team: "Advanced", enterprise: "Advanced" },
  },
  {
    kind: "feature",
    label: "Priority support",
    values: { free: "no", solo: "no", pro: "no", team: "yes", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "API access",
    values: { free: "no", solo: "no", pro: "yes", team: "yes", enterprise: "yes" },
  },

  { kind: "section", label: "Enterprise" },
  {
    kind: "feature",
    label: "SSO / SAML",
    values: { free: "no", solo: "no", pro: "no", team: "no", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Advanced governance",
    values: { free: "no", solo: "no", pro: "no", team: "no", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Enterprise SLA",
    values: { free: "no", solo: "no", pro: "no", team: "no", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Dedicated onboarding",
    values: { free: "no", solo: "no", pro: "no", team: "no", enterprise: "yes" },
  },
  {
    kind: "feature",
    label: "Future AI automation engine",
    values: { free: "soon", solo: "soon", pro: "soon", team: "soon", enterprise: "soon" },
  },
];

const COLUMN_ORDER: Array<{ id: PlanColumnId; label: string; tone: "neutral" | "brand" | "amber" | "violet" }> = [
  { id: "free", label: "Free", tone: "neutral" },
  { id: "solo", label: "Solo", tone: "neutral" },
  { id: "pro", label: "Pro", tone: "brand" },
  { id: "team", label: "Team", tone: "amber" },
  { id: "enterprise", label: "Enterprise", tone: "violet" },
];

export default function BillingComparisonDrawer({
  currentPlanId,
  interval,
}: {
  currentPlanId: string;
  interval: "month" | "year";
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <PremiumCard className="relative overflow-hidden p-4 sm:p-5">
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-subtle/60 text-brand-accent ring-1 ring-brand-accent/15">
              <Layers className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h3 className="text-[13.5px] font-semibold tracking-tight text-ink">
                Compare full features
              </h3>
              <p className="mt-0.5 max-w-2xl text-[11.5px] leading-relaxed text-ink-muted">
                Side-by-side comparison across all five tiers — capacity, intelligence, operations,
                and enterprise features.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand-accent px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-[0_4px_14px_rgba(37,99,235,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_8px_20px_rgba(37,99,235,0.40)]"
          >
            <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
            Open comparison
            <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
          </button>
        </div>
      </PremiumCard>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        side="right"
        size="xl"
        ariaLabel="Plan comparison"
      >
        <div className="flex h-full flex-col">
          <header className="border-b border-border/60 px-5 py-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent">
              Compare plans
            </div>
            <h2 className="mt-1 text-[16px] font-semibold tracking-tight text-ink">
              Full feature comparison
            </h2>
            <p className="mt-0.5 text-[11.5px] text-ink-muted">
              Billing cadence: <span className="font-medium text-ink">{interval === "year" ? "Yearly" : "Monthly"}</span>
            </p>
          </header>

          <div className="flex-1 overflow-y-auto p-5">
            <div className="overflow-x-auto rounded-2xl border border-border/60 bg-surface">
              <table className="w-full text-[11.5px]">
                <thead className="bg-surface-inset/60 text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
                  <tr>
                    <th className="sticky left-0 z-10 bg-surface-inset/60 px-3 py-2.5 text-left">
                      Feature
                    </th>
                    {COLUMN_ORDER.map((col) => (
                      <th
                        key={col.id}
                        className={cn(
                          "px-3 py-2.5 text-center",
                          col.id === currentPlanId && "bg-brand-accent/10 text-brand-accent",
                        )}
                      >
                        <div className="flex flex-col items-center gap-0.5">
                          <span>{col.label}</span>
                          {col.id === currentPlanId && (
                            <span className="inline-flex items-center rounded-full bg-brand-accent px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-white">
                              Current
                            </span>
                          )}
                          {col.id === "pro" && currentPlanId !== "pro" && (
                            <span className="inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-200/40">
                              Popular
                            </span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((row, i) => {
                    if (row.kind === "section") {
                      return (
                        <tr key={`section-${i}`}>
                          <td
                            colSpan={6}
                            className="bg-surface-inset/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.10em] text-brand-accent"
                          >
                            {row.label}
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr
                        key={`row-${row.label}`}
                        className="border-t border-border/40 transition-colors hover:bg-surface-inset/30"
                      >
                        <td className="sticky left-0 z-10 bg-surface px-3 py-2.5 font-medium text-ink">
                          {row.label}
                        </td>
                        {COLUMN_ORDER.map((col) => (
                          <td
                            key={col.id}
                            className={cn(
                              "px-3 py-2.5 text-center",
                              col.id === currentPlanId && "bg-brand-accent/5",
                            )}
                          >
                            <Cell value={row.values[col.id]} />
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3 text-[10.5px] text-ink-subtle">
              <Legend icon={CheckCircle2} tone="positive" label="Included" />
              <Legend icon={Minus} tone="neutral" label="Not included" />
              <Legend icon={Lock} tone="amber" label="Coming soon" />
            </div>
          </div>

          <footer className="border-t border-border/60 bg-surface-inset/40 px-5 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-ink-muted">
                Need more than Enterprise can offer? Reach out — we'll scope it together.
              </p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-[11.5px] font-medium text-ink shadow-soft transition-all hover:bg-surface-inset hover:shadow-md"
              >
                Close
              </button>
            </div>
          </footer>
        </div>
      </Drawer>
    </>
  );
}

function Cell({ value }: { value: string | "yes" | "no" | "soon" }) {
  if (value === "yes") {
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/40">
        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.25} />
      </span>
    );
  }
  if (value === "no") {
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface-inset text-ink-subtle ring-1 ring-border/40">
        <Minus className="h-3.5 w-3.5" strokeWidth={2.25} />
      </span>
    );
  }
  if (value === "soon") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 ring-1 ring-amber-200/40">
        <Lock className="h-2.5 w-2.5" strokeWidth={2} />
        Soon
      </span>
    );
  }
  // Literal value (a number or short label)
  return <span className="text-[11.5px] font-semibold tabular-nums text-ink">{value}</span>;
}

function Legend({
  icon: Icon,
  tone,
  label,
}: {
  icon: LucideIcon;
  tone: "positive" | "neutral" | "amber";
  label: string;
}) {
  const iconTone =
    tone === "positive"
      ? "bg-emerald-50 text-emerald-700 ring-emerald-200/40"
      : tone === "amber"
        ? "bg-amber-50 text-amber-700 ring-amber-200/40"
        : "bg-surface-inset text-ink-subtle ring-border/40";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-flex h-5 w-5 items-center justify-center rounded-full ring-1", iconTone)}>
        <Icon className="h-3 w-3" strokeWidth={2.25} />
      </span>
      {label}
    </span>
  );
}
