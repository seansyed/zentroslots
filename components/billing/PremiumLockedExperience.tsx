"use client";

/**
 * Premium locked experience for high-value lockout pages.
 *
 * Why a separate primitive from LockedFeatureCard:
 *   `LockedFeatureCard` is the compact (one-card) locked treatment used
 *   for surfaces where a Free tenant lands on a feature page (custom
 *   domains, future small features). It's deliberately small.
 *
 *   This primitive is the BIG locked treatment for the highest-value
 *   premium pages — Recurring Scheduling and Follow-up Automations —
 *   where the operator's whole screen is taken over by the lock state.
 *   In those cases, a thin "see plans" link wastes real estate. This
 *   component fills the canvas with:
 *     - aspirational hero (eyebrow + title + tagline + dual CTA)
 *     - feature visualization (custom JSX preview)
 *     - outcome-focused value props (3 cards)
 *     - use-case grid (4-6 chips of real customer scenarios)
 *     - Free-vs-Pro comparison strip
 *     - secondary FAQ-style trust microcopy
 *
 *   ZERO capability/billing logic. Pure UX. Fail-closed: when the
 *   capability is unexpectedly allowed (provider missing → defaults
 *   to allowed=false), this still renders the lock — caller controls
 *   the branch (we don't short-circuit on cap.allowed because the
 *   caller has already made that decision).
 */
import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Crown,
  Lock,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import { useCapability, type Capability } from "./CapabilityProvider";
import { cn } from "@/lib/cn";

// ─── Public API ───────────────────────────────────────────────────────

export type Outcome = {
  icon: LucideIcon;
  title: string;
  body: string;
};

export type Cta = {
  label: string;
  href: string;
};

export type Comparison = {
  free: string[];
  pro: string[];
};

export type PremiumLockedExperienceProps = {
  /** Capability name — used to read the resolved reason string for
   *  the small fine-print under the CTA. */
  cap: Capability;
  /** Short pill label above the title (e.g., "Subscription scheduling"). */
  eyebrow: string;
  /** Display title (large). */
  title: string;
  /** One-sentence punchy value tagline. */
  tagline: string;
  /** 2-3 sentence honest description of what the feature does. */
  description: string;
  /** Primary CTA — brand-accent button. */
  primaryCta: Cta;
  /** Secondary CTA — outlined "see plans" or "talk to sales". */
  secondaryCta?: Cta;
  /** Feature visualization — pure presentational JSX, no business logic. */
  visualization: React.ReactNode;
  /** Three outcome-focused value props. */
  outcomes: Outcome[];
  /** Real use cases as chips. */
  useCases: string[];
  /** Free vs Pro comparison strip. */
  comparison: Comparison;
  /** Optional FAQ-style trust microcopy below the comparison. */
  faqItems?: Array<{ q: string; a: string }>;
};

export function PremiumLockedExperience(props: PremiumLockedExperienceProps) {
  const cap = useCapability(props.cap);
  return (
    <div className="relative overflow-hidden rounded-3xl border border-border bg-surface shadow-sm">
      {/* Ambient depth — three soft brand-tinted blobs for a premium
          glow without using a heavy gradient. Reduced-motion friendly
          (no animation; pure static blur). */}
      <BackgroundGlow />

      <div className="relative">
        {/* ── Hero ────────────────────────────────────────────────── */}
        <Hero
          eyebrow={props.eyebrow}
          title={props.title}
          tagline={props.tagline}
          description={props.description}
          primaryCta={props.primaryCta}
          secondaryCta={props.secondaryCta}
          reason={cap.reason}
        />

        {/* ── Feature visualization ───────────────────────────────── */}
        <div className="border-y border-border/60 bg-gradient-to-b from-brand-subtle/30 via-surface to-surface px-6 py-8 sm:px-10">
          <div className="mx-auto max-w-3xl">{props.visualization}</div>
        </div>

        {/* ── Outcomes grid ───────────────────────────────────────── */}
        <div className="px-6 py-8 sm:px-10">
          <SectionLabel eyebrow="Why operators upgrade" title="Outcomes, not features" />
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {props.outcomes.map((o) => (
              <OutcomeCard key={o.title} {...o} />
            ))}
          </div>
        </div>

        {/* ── Use cases ───────────────────────────────────────────── */}
        <div className="border-t border-border/60 bg-surface-inset/30 px-6 py-8 sm:px-10">
          <SectionLabel eyebrow="Real customer scenarios" title="Built for" />
          <div className="mt-3 flex flex-wrap gap-2">
            {props.useCases.map((u) => (
              <UseCaseChip key={u} label={u} />
            ))}
          </div>
        </div>

        {/* ── Comparison strip ────────────────────────────────────── */}
        <div className="px-6 py-8 sm:px-10">
          <SectionLabel eyebrow="At a glance" title="Free vs Pro" />
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <PlanColumn
              tone="current"
              name="Your current plan"
              items={props.comparison.free}
            />
            <PlanColumn tone="upgrade" name="Pro" items={props.comparison.pro} />
          </div>
        </div>

        {/* ── Optional FAQ ────────────────────────────────────────── */}
        {props.faqItems && props.faqItems.length > 0 && (
          <div className="border-t border-border/60 bg-surface-inset/20 px-6 py-8 sm:px-10">
            <SectionLabel eyebrow="Common questions" title="Before you upgrade" />
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              {props.faqItems.map((item) => (
                <FaqItem key={item.q} q={item.q} a={item.a} />
              ))}
            </div>
          </div>
        )}

        {/* ── Footer CTA repeat ──────────────────────────────────── */}
        <div className="border-t border-border/60 bg-gradient-to-br from-brand-subtle/40 via-surface to-surface px-6 py-8 text-center sm:px-10">
          <CtaButton {...props.primaryCta} large />
          <p className="mt-2 text-[11px] text-ink-subtle">
            Upgrade anytime · cancel anytime · billed via Stripe
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Hero ─────────────────────────────────────────────────────────────

function Hero({
  eyebrow,
  title,
  tagline,
  description,
  primaryCta,
  secondaryCta,
  reason,
}: {
  eyebrow: string;
  title: string;
  tagline: string;
  description: string;
  primaryCta: Cta;
  secondaryCta?: Cta;
  reason: string;
}) {
  return (
    <div className="px-6 pt-10 pb-8 text-center sm:px-10 sm:pt-14 sm:pb-10">
      {/* Locked indicator pill — establishes the page is gated without
          shouting it. The Crown icon signals "premium tier" rather
          than the harsher Lock alone. */}
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700 ring-1 ring-amber-200/50">
        <Crown className="h-3 w-3" strokeWidth={2.25} />
        Pro feature
      </span>

      {/* Eyebrow */}
      <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
        <Sparkles className="h-3 w-3" strokeWidth={2.25} />
        {eyebrow}
      </div>

      {/* Title */}
      <h1 className="mt-4 text-[28px] font-semibold tracking-tight text-ink sm:text-[36px] sm:leading-tight">
        {title}
      </h1>

      {/* Tagline — bold, single sentence */}
      <p className="mx-auto mt-3 max-w-2xl text-[15px] font-medium leading-relaxed text-ink sm:text-[17px]">
        {tagline}
      </p>

      {/* Description — secondary explanatory copy */}
      <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-ink-muted">
        {description}
      </p>

      {/* CTAs */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <CtaButton {...primaryCta} large />
        {secondaryCta && (
          <Link
            href={secondaryCta.href}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink shadow-sm transition-all hover:-translate-y-0.5 hover:bg-surface-inset"
          >
            {secondaryCta.label}
          </Link>
        )}
      </div>

      {/* Fine-print reason (from capability resolver) */}
      <p className="mt-3 text-[11px] text-ink-subtle">{reason}</p>
    </div>
  );
}

// ─── Reusable primitives ──────────────────────────────────────────────

function CtaButton({ label, href, large }: Cta & { large?: boolean }) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-1.5 rounded-full bg-brand-accent font-semibold text-white shadow-[0_8px_24px_rgba(53,157,243,0.32)] transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:bg-brand-accent/95 hover:shadow-[0_12px_32px_rgba(53,157,243,0.42)]",
        large ? "px-5 py-2.5 text-[14px]" : "px-4 py-2 text-[13px]",
      )}
    >
      <span aria-hidden className="relative inline-flex h-2 w-2">
        <span className="absolute inset-0 inline-flex h-full w-full animate-ping rounded-full bg-white/60" />
        <span className="relative inline-block h-2 w-2 rounded-full bg-white" />
      </span>
      {label}
      <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" strokeWidth={2.25} />
    </Link>
  );
}

function SectionLabel({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="text-center sm:text-left">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-brand-accent">
        {eyebrow}
      </div>
      <h2 className="mt-0.5 text-[18px] font-semibold tracking-tight text-ink">{title}</h2>
    </div>
  );
}

function OutcomeCard({ icon: Icon, title, body }: Outcome) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border/60 bg-surface p-4 transition-all duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-soft">
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent" />
      <span
        aria-hidden
        className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full bg-brand-accent/[0.08] blur-2xl transition-opacity duration-[260ms] group-hover:opacity-100"
      />
      <div className="relative">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
        <h3 className="mt-3 text-[13px] font-semibold tracking-tight text-ink">{title}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{body}</p>
      </div>
    </div>
  );
}

function UseCaseChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-muted shadow-sm transition-colors hover:bg-surface-inset/60 hover:text-ink">
      <CheckCircle2 className="h-3 w-3 text-emerald-600" strokeWidth={2.25} />
      {label}
    </span>
  );
}

function PlanColumn({
  tone,
  name,
  items,
}: {
  tone: "current" | "upgrade";
  name: string;
  items: string[];
}) {
  const isUpgrade = tone === "upgrade";
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl p-5 transition-all duration-[260ms]",
        isUpgrade
          ? "border-2 border-brand-accent/40 bg-gradient-to-br from-brand-subtle/40 via-surface to-surface shadow-[0_8px_24px_rgba(53,157,243,0.16)]"
          : "border border-border/60 bg-surface",
      )}
    >
      {isUpgrade && (
        <div className="absolute right-3 top-3 inline-flex items-center gap-1 rounded-full bg-brand-accent px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-white shadow-sm">
          <Sparkles className="h-2.5 w-2.5" strokeWidth={2.25} />
          Recommended
        </div>
      )}
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">
        {isUpgrade ? "Upgrade to" : "You're on"}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[20px] font-semibold tracking-tight text-ink">{name}</span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {items.map((item) => (
          <li
            key={item}
            className={cn(
              "flex items-start gap-2 text-[12.5px]",
              isUpgrade ? "text-ink" : "text-ink-muted",
            )}
          >
            {isUpgrade ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-accent" strokeWidth={2.25} />
            ) : (
              <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-ink-subtle" strokeWidth={2.25} />
            )}
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface p-3">
      <div className="text-[12.5px] font-semibold tracking-tight text-ink">{q}</div>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">{a}</p>
    </div>
  );
}

// ─── Background glow (static, reduced-motion friendly) ────────────────

function BackgroundGlow() {
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-accent/[0.10] blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -left-24 top-72 h-72 w-72 rounded-full bg-amber-200/[0.20] blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-24 right-1/3 h-72 w-72 rounded-full bg-emerald-200/[0.18] blur-3xl"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent"
      />
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Feature-specific visualizations
// ═══════════════════════════════════════════════════════════════════════

// ─── Recurring scheduling preview ─────────────────────────────────────
//
// 6-column mini calendar grid (Mon–Sat) over 4 weeks. Highlighted
// circles on every Monday (and one Tuesday + one Thursday for visual
// variety) to suggest a weekly recurring pattern. A subtle pulse
// animation on the "today" cell signals live behavior. Pure CSS — no
// chart library.

export function RecurringSchedulingPreview() {
  const days = ["M", "T", "W", "T", "F", "S"];
  // 4 weeks × 6 days. Encode which cells have recurring "appointments":
  //   - col 0 (Mon) → all 4 weeks (weekly recurring)
  //   - col 3 (Thu) → weeks 1 + 3 (bi-weekly)
  // The "now" cell (week 1 Mon) gets a pulse ring.
  const cells: Array<{ recurring: boolean; isPrimary: boolean; isNow: boolean }>[] = [];
  for (let w = 0; w < 4; w++) {
    const row: Array<{ recurring: boolean; isPrimary: boolean; isNow: boolean }> = [];
    for (let d = 0; d < 6; d++) {
      const isWeekly = d === 0;
      const isBiweekly = d === 3 && (w === 0 || w === 2);
      row.push({
        recurring: isWeekly || isBiweekly,
        isPrimary: isWeekly,
        isNow: w === 0 && d === 0,
      });
    }
    cells.push(row);
  }
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px] lg:items-center">
      {/* Calendar grid */}
      <div className="rounded-2xl border border-border/60 bg-surface p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Recurrence preview
            </div>
            <div className="mt-0.5 text-[13px] font-semibold tracking-tight text-ink">
              Every Monday at 10:00 AM
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-emerald-700 ring-1 ring-emerald-200/50">
            <span aria-hidden className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Auto-generating
          </span>
        </div>

        {/* Header */}
        <div className="mt-4 grid grid-cols-6 gap-2 text-center text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
          {days.map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </div>

        {/* Grid */}
        <div className="mt-1.5 space-y-2">
          {cells.map((row, w) => (
            <div key={w} className="grid grid-cols-6 gap-2">
              {row.map((cell, d) => (
                <div
                  key={d}
                  className={cn(
                    "relative aspect-square rounded-lg border text-[10px] tabular-nums transition-colors",
                    cell.recurring
                      ? cell.isPrimary
                        ? "border-brand-accent/50 bg-brand-accent/10"
                        : "border-emerald-300/50 bg-emerald-50/60"
                      : "border-border/40 bg-surface-inset/30",
                  )}
                >
                  {cell.recurring && (
                    <span
                      className={cn(
                        "absolute inset-1.5 flex items-center justify-center rounded-md text-[9px] font-semibold",
                        cell.isPrimary
                          ? "bg-brand-accent text-white"
                          : "bg-emerald-100 text-emerald-700",
                      )}
                    >
                      {cell.isPrimary ? "10A" : "Thu"}
                    </span>
                  )}
                  {cell.isNow && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute -inset-0.5 animate-ping rounded-lg ring-2 ring-brand-accent/40"
                    />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Legend */}
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[10.5px] text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded bg-brand-accent" />
            Weekly
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded bg-emerald-400" />
            Bi-weekly
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded border border-border bg-surface" />
            Open
          </span>
        </div>
      </div>

      {/* Side annotations */}
      <div className="space-y-3">
        <AnnotationLine
          label="Validates every occurrence"
          body="Each materialized booking runs through booking rules, routing, and availability before it's confirmed."
        />
        <AnnotationLine
          label="Same notifications as direct bookings"
          body="Reminders, calendar sync, and confirmations fire automatically per occurrence."
        />
        <AnnotationLine
          label="Pause or cancel anytime"
          body="Stop the series without affecting already-booked occurrences on the calendar."
        />
      </div>
    </div>
  );
}

// ─── Follow-up automation preview ─────────────────────────────────────
//
// Workflow flowchart: Booking event → Wait window → Send message →
// (optional) Track conversion. Three branches stacked. Each branch is
// a card with arrows between steps. Pure flexbox + SVG arrows.

export function AutomationWorkflowPreview() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border/60 bg-surface p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.10em] text-ink-subtle">
              Workflow preview
            </div>
            <div className="mt-0.5 text-[13px] font-semibold tracking-tight text-ink">
              Three automations, always-on
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.10em] text-emerald-700 ring-1 ring-emerald-200/50">
            <span aria-hidden className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            Cron-driven
          </span>
        </div>

        <div className="mt-5 space-y-4">
          <WorkflowRow
            trigger={{ label: "Booking completed", tone: "emerald" }}
            wait="Wait 2 hours"
            action={{ label: "Send review request", tone: "brand" }}
            outcomeLabel="Review on Google / Yelp"
            outcomeTone="emerald"
          />
          <WorkflowRow
            trigger={{ label: "No-show recorded", tone: "amber" }}
            wait="Wait 1 day"
            action={{ label: "Rebooking nudge", tone: "brand" }}
            outcomeLabel="Customer reschedules"
            outcomeTone="sky"
          />
          <WorkflowRow
            trigger={{ label: "First visit complete", tone: "sky" }}
            wait="Wait 7 days"
            action={{ label: "Welcome follow-up", tone: "brand" }}
            outcomeLabel="Repeat booking rate ↑"
            outcomeTone="emerald"
          />
        </div>

        {/* Legend */}
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border/40 pt-3 text-[10.5px] text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
            Trigger
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-brand-accent" />
            Action
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full bg-sky-400" />
            Outcome
          </span>
        </div>
      </div>
    </div>
  );
}

function WorkflowRow({
  trigger,
  wait,
  action,
  outcomeLabel,
  outcomeTone,
}: {
  trigger: { label: string; tone: "emerald" | "amber" | "sky" };
  wait: string;
  action: { label: string; tone: "brand" };
  outcomeLabel: string;
  outcomeTone: "emerald" | "sky" | "amber";
}) {
  const triggerTone: Record<typeof trigger.tone, string> = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200/55",
    amber: "bg-amber-50 text-amber-700 ring-amber-200/55",
    sky: "bg-sky-50 text-sky-700 ring-sky-200/55",
  };
  const outcomeToneCls: Record<typeof outcomeTone, string> = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200/55",
    sky: "bg-sky-50 text-sky-700 ring-sky-200/55",
    amber: "bg-amber-50 text-amber-700 ring-amber-200/55",
  };
  return (
    <div className="grid grid-cols-[auto_1fr_auto_1fr_auto_1fr] items-center gap-2">
      {/* Trigger */}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11.5px] font-semibold ring-1 shadow-sm",
          triggerTone[trigger.tone],
        )}
      >
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        {trigger.label}
      </span>

      {/* Arrow + wait label */}
      <div className="flex items-center gap-1">
        <Arrow />
        <span className="whitespace-nowrap rounded-full bg-surface-inset px-2 py-0.5 text-[10px] font-medium text-ink-subtle">
          {wait}
        </span>
        <Arrow />
      </div>

      {/* Action */}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-xl bg-brand-subtle/70 px-3 py-2 text-[11.5px] font-semibold text-brand-accent ring-1 ring-brand-accent/20 shadow-sm",
        )}
      >
        <Sparkles className="h-3 w-3" strokeWidth={2.25} />
        {action.label}
      </span>

      <Arrow />

      {/* Outcome */}
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11.5px] font-semibold ring-1 shadow-sm",
          outcomeToneCls[outcomeTone],
        )}
      >
        <CheckCircle2 className="h-3 w-3" strokeWidth={2.25} />
        {outcomeLabel}
      </span>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      aria-hidden
      width="18"
      height="8"
      viewBox="0 0 18 8"
      fill="none"
      className="shrink-0 text-ink-subtle"
    >
      <path d="M1 4 H15" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M12 1 L16 4 L12 7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function AnnotationLine({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface-inset/30 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-subtle/70 text-brand-accent ring-1 ring-brand-accent/15">
          <Sparkles className="h-3 w-3" strokeWidth={2.25} />
        </span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold tracking-tight text-ink">{label}</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-muted">{body}</p>
        </div>
      </div>
    </div>
  );
}

// Silence unused-import warning if Lock isn't used inline anywhere — we
// re-export so feature pages can compose with the icon if desired.
void Lock;
