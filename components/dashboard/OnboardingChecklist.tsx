"use client";

/**
 * OnboardingChecklist — premium activation workspace (Phase 4).
 *
 * Replaces the plain checklist box with a Notion/Linear/Vercel-style
 * onboarding surface. Data contract is preserved exactly:
 *
 *   props.items: ChecklistItem[]   { id, label, href, done }
 *
 * The 5 known step ids are enriched here (icon, description, est. time,
 * category) via a local STEP_META map. Unknown ids degrade gracefully
 * to a generic "Setup" card so the component never crashes if the
 * server adds a new step.
 *
 * What changed vs Phase 1:
 *   - PremiumCard surface with hero-glow + corner brand glow
 *   - Stronger header hierarchy (eyebrow + title + sub) + circular %
 *   - Thicker animated progress bar with shimmer overlay
 *   - Steps grouped under FOUNDATION / BOOKING SETUP / ACTIVATION
 *   - Rich step cards (icon container + title + desc + time + CTA)
 *   - FadeIn staggered entrance
 *   - Onboarding InsightCard nudge ("Most teams finish in <5 min…")
 *   - Premium completion celebration (brand gradient, not green-50)
 *
 * What is preserved verbatim:
 *   - The {id, label, href, done} contract
 *   - The "checklist_complete_dismissed" localStorage one-shot
 *   - The "hide entirely when done && dismissed" behavior
 *   - All hrefs (caller-supplied, not overridden here)
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
  type LucideIcon,
} from "lucide-react";

import { PremiumCard, InsightCard } from "@/components/ui/Card";
import { FadeIn } from "@/components/ui/Motion";
import { cn } from "@/lib/cn";

// ─── Public contract ────────────────────────────────────────────────

export type ChecklistItem = {
  id: string;
  label: string;
  href: string;
  done: boolean;
};

// ─── Step metadata (local enrichment, keyed by known ids) ───────────

type StepCategory = "foundation" | "booking" | "activation";

type StepMeta = {
  icon: LucideIcon;
  description: string;
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
    description: "Define when customers can book you each week.",
    estimatedTime: "2 min",
    category: "foundation",
  },
  service: {
    icon: Briefcase,
    description: "Create the offering customers will book.",
    estimatedTime: "2 min",
    category: "booking",
  },
  branding: {
    icon: Palette,
    description: "Match your booking page to your brand.",
    estimatedTime: "1 min",
    category: "booking",
  },
  booking: {
    icon: Rocket,
    description: "Share your booking link and accept your first appointment.",
    estimatedTime: "—",
    category: "activation",
  },
};

const CATEGORY_LABELS: Record<StepCategory, { eyebrow: string; subtitle: string }> = {
  foundation: { eyebrow: "Foundation", subtitle: "Connect the essentials" },
  booking:    { eyebrow: "Booking setup", subtitle: "Define what you offer" },
  activation: { eyebrow: "Activation",   subtitle: "Go live and grow" },
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

const DISMISS_KEY = "checklist_complete_dismissed";

export default function OnboardingChecklist({ items }: { items: ChecklistItem[] }) {
  const [dismissed, setDismissed] = React.useState(false);

  const done = items.filter((i) => i.done).length;
  const total = items.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const isComplete = total > 0 && done === total;

  // Hide entirely once everything is checked off (one-shot persistence) —
  // preserves Phase 1 behavior bit-for-bit.
  React.useEffect(() => {
    if (isComplete) {
      if (typeof window !== "undefined" && window.localStorage.getItem(DISMISS_KEY) === "1") {
        setDismissed(true);
      }
    }
  }, [isComplete]);

  // ── Completion celebration ──────────────────────────────────────
  if (isComplete) {
    if (dismissed) return null;
    return (
      <FadeIn className="mb-6">
        <CompletionCard
          onDismiss={() => {
            if (typeof window !== "undefined") {
              window.localStorage.setItem(DISMISS_KEY, "1");
            }
            setDismissed(true);
          }}
        />
      </FadeIn>
    );
  }

  // ── Group items by category, preserving order ────────────────────
  const grouped: Record<StepCategory, ChecklistItem[]> = {
    foundation: [],
    booking: [],
    activation: [],
  };
  for (const item of items) {
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
        <div className="relative flex items-start justify-between gap-4">
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

          {/* Circular percentage */}
          <CircularProgress pct={pct} />
        </div>

        {/* Progress bar */}
        <div className="relative mt-5">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="font-medium text-ink-muted">
              <span className="tabular-nums text-ink">{done}</span> of{" "}
              <span className="tabular-nums">{total}</span> steps complete
            </span>
            <span className="font-semibold tabular-nums text-brand-accent">{pct}%</span>
          </div>
          <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-surface-inset ring-1 ring-border/60">
            <div
              className="relative h-full rounded-full bg-gradient-to-r from-brand-accent via-brand-accent to-brand-hover shadow-[0_0_12px_rgba(53,157,243,0.45)] transition-[width] duration-700 ease-out"
              style={{ width: `${pct}%` }}
            >
              {/* Shimmer sweep */}
              <div
                aria-hidden
                className="absolute inset-0 overflow-hidden rounded-full"
              >
                <div className="absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-white/50 to-transparent zm-shimmer" />
              </div>
            </div>
          </div>
        </div>

        {/* Grouped steps */}
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

// ─── Category section ───────────────────────────────────────────────

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

// ─── Step card ──────────────────────────────────────────────────────

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
        {/* Icon container — swaps to check when done */}
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

          {/* CTA row */}
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

// ─── Completion celebration ─────────────────────────────────────────

function CompletionCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <PremiumCard
      interactive={false}
      className="relative overflow-hidden bg-gradient-to-br from-brand-subtle/60 via-surface to-surface"
    >
      {/* Confetti-style soft glows */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-brand-accent/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-16 bottom-0 h-40 w-40 rounded-full bg-emerald-400/10 blur-3xl"
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
          className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-accent to-brand-hover text-white shadow-[0_8px_24px_rgba(53,157,243,0.35)]"
        >
          <PartyPopper className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
            All set
          </div>
          <h2 className="mt-0.5 text-[17px] font-semibold tracking-tight text-ink">
            Your workspace is ready
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
            Setup is complete. Share your booking link and start filling your calendar.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Link
              href="/dashboard/calendar"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-accent px-3 text-[12px] font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-md"
            >
              Open calendar
              <ArrowRight className="h-3 w-3" strokeWidth={2.25} />
            </Link>
            <Link
              href="/dashboard/settings/branding"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[12px] font-medium text-ink-muted transition-colors hover:bg-surface-inset hover:text-ink"
            >
              Customize booking page
            </Link>
          </div>
        </div>
      </div>
    </PremiumCard>
  );
}
