"use client";

/**
 * OnboardingChecklist — plan-aware activation workspace.
 *
 * Phase Onboarding-UX upgrade:
 *   • Splits tasks into REQUIRED vs PREMIUM (capability-gated).
 *     Free users see "Customize your booking page" as a Premium
 *     card with a PRO badge + Upgrade CTA — it NEVER counts
 *     against completion percentage.
 *   • Completion math is plan-aware: a Free user with all 4
 *     required tasks done sees "Workspace ready" at 100% even
 *     though branding (PRO-only) is unfinished.
 *   • Dismiss button persists to DB via /api/onboarding/dismiss
 *     (replaces the localStorage-only one-shot). The dashboard
 *     re-renders without the card and surfaces a tiny "Resume
 *     setup" pill instead.
 *   • Success state shown once all required done, with a copy-
 *     booking-link CTA + soft "Unlock more" pointer (NOT an
 *     aggressive upsell).
 *
 * Data contract additions (backward-compatible):
 *   ChecklistItem:
 *     id, label, href, done, requiredCapability?, category?
 *   New props:
 *     plan       (Plan)               — for capability gating
 *     bookingUrl (string | undefined) — for the "Copy link" CTA
 *
 * Existing 5-key STEP_META is reused. New "branding" task carries
 * `requiredCapability: "customBranding"` upstream, so on Free
 * plans it lands in the premium section automatically.
 */

import * as React from "react";
import Link from "next/link";
import {
  CalendarCheck,
  Clock4,
  Briefcase,
  Palette,
  Rocket,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  PartyPopper,
  X,
  Lock,
  Copy as CopyIcon,
  type LucideIcon,
} from "lucide-react";

import { PremiumCard, InsightCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";
import {
  cheapestPlanWithCapability,
  type Plan,
  type PlanCapability,
} from "@/lib/plans";
import { partitionByPlan } from "@/lib/onboarding/completion";

// ─── Public contract ────────────────────────────────────────────────

export type ChecklistItem = {
  id: string;
  label: string;
  href: string;
  done: boolean;
  /** When set, this task is REQUIRED only when the tenant's plan
   *  has the capability. Otherwise it's surfaced as a Premium
   *  card with an upgrade CTA and never counts toward completion. */
  requiredCapability?: PlanCapability;
};

// ─── Step metadata (local enrichment, keyed by known ids) ───────────

type StepCategory = "foundation" | "booking" | "activation";

type StepMeta = {
  icon: LucideIcon;
  description: string;
  /** Description used when the task is rendered in the PREMIUM
   *  section — emphasizes the marketing value. */
  premiumDescription?: string;
  estimatedTime: string;
  category: StepCategory;
};

const STEP_META: Record<string, StepMeta> = {
  google: {
    icon: CalendarCheck,
    description: "Sync availability and avoid double-bookings.",
    estimatedTime: "1 min",
    category: "foundation",
  },
  hours: {
    icon: Clock4,
    description: "Tell us when you're available to take bookings.",
    estimatedTime: "1 min",
    category: "foundation",
  },
  service: {
    icon: Briefcase,
    description: "Define what customers can book with you.",
    estimatedTime: "2 min",
    category: "booking",
  },
  branding: {
    icon: Palette,
    description: "Add your logo, brand colors, and tagline.",
    premiumDescription:
      "Personalize colors, branding, and layout to match your business.",
    estimatedTime: "2 min",
    category: "booking",
  },
  booking: {
    icon: Rocket,
    description: "You're live! Watch your first booking come in.",
    estimatedTime: "—",
    category: "activation",
  },
};

const CATEGORY_LABELS: Record<StepCategory, { eyebrow: string; subtitle: string }> = {
  foundation: { eyebrow: "Foundation", subtitle: "Connect the essentials" },
  booking: { eyebrow: "Booking setup", subtitle: "Define what you offer" },
  activation: { eyebrow: "Activation", subtitle: "Go live and grow" },
};

const CATEGORY_ORDER: StepCategory[] = ["foundation", "booking", "activation"];

function metaFor(id: string): StepMeta {
  return (
    STEP_META[id] ?? {
      icon: Sparkles,
      description: "Finish this step to keep moving.",
      estimatedTime: "1 min",
      category: "foundation",
    }
  );
}

// ─── Component ──────────────────────────────────────────────────────

export default function OnboardingChecklist({
  items,
  plan,
  bookingUrl,
}: {
  items: ChecklistItem[];
  plan: Plan;
  /** Tenant booking URL. When provided, the success state shows a
   *  Copy-link CTA. */
  bookingUrl?: string;
}) {
  // Phase Onboarding-UX — server-persisted dismiss. We optimistically
  // hide the card on click; the API call is fire-and-forget. The
  // server-side render decides whether to show the card on the next
  // page load.
  const [dismissed, setDismissed] = React.useState(false);

  // Plan-aware partition. Free users see customBranding land in
  // `premium`; paid users see it as a regular required task.
  const partitioned = React.useMemo(
    () => partitionByPlan(items, plan),
    [items, plan],
  );
  const { required, premium, requiredDone, requiredTotal, isReady, pct } = partitioned;

  const handleDismiss = React.useCallback(() => {
    setDismissed(true);
    // Fire-and-forget. The dashboard reads the column on next
    // render; transient network failures degrade to a one-tab
    // hide (re-appears on hard refresh — acceptable for a UX
    // dismissal).
    fetch("/api/onboarding/dismiss", { method: "POST" }).catch(() => {
      /* silent */
    });
  }, []);

  if (dismissed) return null;

  // ── Completion celebration ──────────────────────────────────────
  if (isReady) {
    return (
      <FadeIn className="mb-6">
        <CompletionCard
          onDismiss={handleDismiss}
          bookingUrl={bookingUrl}
          hasPremiumOpportunities={premium.length > 0}
        />
      </FadeIn>
    );
  }

  // ── Group REQUIRED items by category, preserving order ───────────
  const grouped: Record<StepCategory, ChecklistItem[]> = {
    foundation: [],
    booking: [],
    activation: [],
  };
  for (const item of required) {
    const cat = metaFor(item.id).category;
    grouped[cat].push(item);
  }

  return (
    <FadeIn className="mb-6">
      <PremiumCard
        interactive={false}
        className={cn(
          "relative overflow-hidden",
          "bg-gradient-to-br from-brand-subtle/40 via-surface to-surface",
        )}
      >
        {/* Dismiss button — anytime, persists to DB. */}
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Hide setup checklist"
          className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
          title="Skip for now"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>

        {/* Soft brand corner glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-brand-accent/10 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -left-16 h-56 w-56 rounded-full bg-brand-accent/5 blur-3xl"
        />

        {/* Header */}
        <div className="relative flex items-start justify-between gap-4 pr-8">
          <div className="flex min-w-0 items-start gap-3">
            <div
              aria-hidden
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft"
            >
              <Sparkles className="h-[18px] w-[18px]" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
                Getting started
              </div>
              <h2 className="mt-0.5 text-[16px] font-semibold tracking-tight text-ink sm:text-[17px]">
                Complete your workspace setup
              </h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                Finish a few quick steps to start accepting bookings.
              </p>
            </div>
          </div>

          {/* Circular percentage — REQUIRED-only math */}
          <CircularProgress pct={pct} />
        </div>

        {/* Progress bar */}
        <div className="relative mt-5">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="font-medium text-ink-muted">
              <span className="tabular-nums text-ink">{requiredDone}</span> of{" "}
              <span className="tabular-nums">{requiredTotal}</span> required steps complete
            </span>
            <span className="font-semibold tabular-nums text-brand-accent">{pct}%</span>
          </div>
          <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-surface-inset ring-1 ring-border/60">
            <div
              className="relative h-full rounded-full bg-gradient-to-r from-brand-accent via-brand-accent to-brand-hover shadow-[0_0_12px_rgba(53,157,243,0.45)] transition-[width] duration-700 ease-out"
              style={{ width: `${pct}%` }}
            >
              <div
                aria-hidden
                className="absolute inset-0 overflow-hidden rounded-full"
              >
                <div className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-white/50 to-transparent zm-shimmer" />
              </div>
            </div>
          </div>
        </div>

        {/* Grouped REQUIRED steps */}
        <div className="relative mt-6 space-y-5">
          {CATEGORY_ORDER.map((cat) => {
            const group = grouped[cat];
            if (group.length === 0) return null;
            return (
              <CategorySection
                key={cat}
                eyebrow={CATEGORY_LABELS[cat].eyebrow}
                subtitle={CATEGORY_LABELS[cat].subtitle}
                items={group}
              />
            );
          })}
        </div>

        {/* PREMIUM section — locked features that don't count */}
        {premium.length > 0 ? (
          <div className="relative mt-6 border-t border-border/60 pt-5">
            <div className="mb-2.5 flex items-baseline justify-between">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700">
                  Unlock more
                </span>
                <span className="text-[11px] text-ink-muted">·</span>
                <span className="text-[11px] text-ink-muted">
                  Optional features available on paid plans
                </span>
              </div>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {premium.map((item, idx) => (
                <FadeIn key={item.id} delay={idx} as="div">
                  <PremiumStepCard item={item} />
                </FadeIn>
              ))}
            </ul>
          </div>
        ) : null}

        {/* Insight nudge */}
        <div className="relative mt-6">
          <InsightCard title="Setup tip">
            Most teams finish in under 5 minutes. Connecting your calendar first cuts
            no-shows and prevents double-bookings.
          </InsightCard>
        </div>
      </PremiumCard>
    </FadeIn>
  );
}

// ─── Circular progress (in-header) ──────────────────────────────────

function CircularProgress({ pct }: { pct: number }) {
  const r = 22;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  return (
    <div className="relative hidden h-14 w-14 shrink-0 sm:block" aria-hidden>
      <svg viewBox="0 0 56 56" className="h-14 w-14 -rotate-90">
        <circle
          cx="28"
          cy="28"
          r={r}
          className="fill-none stroke-surface-inset"
          strokeWidth="4"
        />
        <circle
          cx="28"
          cy="28"
          r={r}
          className="fill-none stroke-brand-accent transition-[stroke-dasharray] duration-700 ease-out"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ filter: "drop-shadow(0 0 6px rgba(53,157,243,0.35))" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[12px] font-semibold tabular-nums text-ink">{pct}%</span>
      </div>
    </div>
  );
}

// ─── Category section (REQUIRED tasks) ──────────────────────────────

function CategorySection({
  eyebrow,
  subtitle,
  items,
}: {
  eyebrow: string;
  subtitle: string;
  items: ChecklistItem[];
}) {
  const groupDone = items.filter((i) => i.done).length;
  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            {eyebrow}
          </span>
          <span className="text-[11px] text-ink-muted">·</span>
          <span className="text-[11px] text-ink-muted">{subtitle}</span>
        </div>
        <span className="text-[10px] font-medium tabular-nums text-ink-subtle">
          {groupDone}/{items.length}
        </span>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map((item, idx) => (
          <FadeIn key={item.id} delay={idx} as="div">
            <StepCard item={item} />
          </FadeIn>
        ))}
      </ul>
    </section>
  );
}

// ─── Standard step card (REQUIRED task) ─────────────────────────────

function StepCard({ item }: { item: ChecklistItem }) {
  const meta = metaFor(item.id);
  const Icon = meta.icon;
  const done = item.done;

  return (
    <Link
      href={item.href}
      className={cn(
        "group relative block overflow-hidden rounded-xl border p-3.5 transition-all duration-200 ease-out",
        done
          ? "border-emerald-200/70 bg-emerald-50/40 hover:bg-emerald-50/60"
          : "border-border bg-surface hover:-translate-y-0.5 hover:border-brand-accent/30 hover:shadow-soft",
      )}
      aria-label={done ? `${item.label} (complete)` : `${item.label} — set up`}
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 transition-all duration-200 group-hover:scale-105",
            done
              ? "bg-emerald-500 text-white ring-emerald-300/40 shadow-[0_0_10px_rgba(16,185,129,0.25)]"
              : "bg-brand-subtle text-brand-accent ring-brand-accent/15",
          )}
        >
          {done ? (
            <CheckCircle2 className="h-[18px] w-[18px]" strokeWidth={2} />
          ) : (
            <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "truncate text-[13px] font-semibold",
                done ? "text-emerald-900/80" : "text-ink",
              )}
            >
              {item.label}
            </div>
            {!done && meta.estimatedTime !== "—" && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-inset px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-ink-subtle">
                <Clock4 className="h-2.5 w-2.5" strokeWidth={2} />
                {meta.estimatedTime}
              </span>
            )}
          </div>
          <p
            className={cn(
              "mt-0.5 text-[11px] leading-relaxed",
              done ? "text-emerald-900/60" : "text-ink-muted",
            )}
          >
            {meta.description}
          </p>

          <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium">
            {done ? (
              <span className="text-emerald-700">Complete</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-brand-accent transition-transform duration-200 group-hover:translate-x-0.5">
                Set up
                <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

// ─── Premium step card (PRO-only, locked) ───────────────────────────

function PremiumStepCard({ item }: { item: ChecklistItem }) {
  const meta = metaFor(item.id);
  const Icon = meta.icon;
  const cap = item.requiredCapability;
  const cheapestPlan = cap ? cheapestPlanWithCapability(cap) : null;
  const planLabel = cheapestPlan?.name ?? "Pro";

  return (
    <Link
      href="/dashboard/settings/billing"
      className="group relative block overflow-hidden rounded-xl border border-amber-200/70 bg-gradient-to-br from-amber-50/40 to-surface p-3.5 transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-amber-300 hover:shadow-soft"
      aria-label={`${item.label} — upgrade to ${planLabel}`}
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-100/80 text-amber-700 ring-1 ring-amber-200 transition-all duration-200 group-hover:scale-105"
        >
          <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-[13px] font-semibold text-ink">
              {item.label}
            </div>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-800">
              <Lock className="h-2.5 w-2.5" strokeWidth={2.5} />
              {planLabel}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">
            {meta.premiumDescription ?? meta.description}
          </p>

          <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium">
            <span className="inline-flex items-center gap-1 text-amber-800 transition-transform duration-200 group-hover:translate-x-0.5">
              Upgrade to {planLabel}
              <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
            </span>
          </div>
        </div>
      </div>
    </Link>
  );
}

// ─── Completion celebration ─────────────────────────────────────────

function CompletionCard({
  onDismiss,
  bookingUrl,
  hasPremiumOpportunities,
}: {
  onDismiss: () => void;
  bookingUrl?: string;
  hasPremiumOpportunities: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const handleCopy = React.useCallback(async () => {
    if (!bookingUrl) return;
    try {
      await navigator.clipboard.writeText(bookingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked; the link is still visible */
    }
  }, [bookingUrl]);

  return (
    <PremiumCard
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-emerald-50/60 via-surface to-surface"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-emerald-400/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-16 bottom-0 h-40 w-40 rounded-full bg-brand-accent/10 blur-3xl"
      />

      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>

      <div className="relative flex items-start gap-4">
        <div
          aria-hidden
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 text-white shadow-[0_8px_24px_rgba(16,185,129,0.35)]"
        >
          <PartyPopper className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700">
            All set
          </div>
          <h2 className="mt-0.5 text-[17px] font-semibold tracking-tight text-ink">
            You&rsquo;re ready to accept bookings
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            Workspace setup is complete. Share your booking link and start filling your calendar.
          </p>

          {/* Copy booking link CTA */}
          {bookingUrl ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[11px] font-mono text-ink-muted">
                <span className="max-w-[280px] truncate">{bookingUrl}</span>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1 rounded-md bg-brand-accent px-2 py-0.5 text-[10px] font-medium text-white hover:bg-brand-hover"
                  title="Copy booking link"
                >
                  <CopyIcon className="h-2.5 w-2.5" strokeWidth={2.5} />
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              href="/dashboard/calendar"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-accent px-3 text-[12px] font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-md"
            >
              Open calendar
              <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
            </Link>
            {/* Soft (NOT aggressive) upsell — only when premium tasks exist */}
            {hasPremiumOpportunities ? (
              <Link
                href="/dashboard/settings/billing"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50/60 px-3 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-50"
              >
                Unlock more features
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}
