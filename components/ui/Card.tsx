/**
 * Premium reusable card primitives (Phase 2).
 *
 * All server-renderable (no "use client"). The Card system enforces a
 * unified premium visual language across every dashboard surface:
 *
 *   PremiumCard   — the default elevated container (white, rounded-2xl,
 *                   shadow-soft, hover→shadow-lift + translateY)
 *   MetricCard    — KPI variant with icon container slot + value typography
 *   GlassCard     — translucent + backdrop-blur for floating panels (rare)
 *   InsightCard   — branded gradient + Sparkles affordance for AI nudges
 *   SectionHeader — consistent title + optional href link + optional
 *                   eyebrow label
 *
 * Each component accepts `className` so callers can fine-tune without
 * forking the primitive.
 */
import * as React from "react";
import Link from "next/link";
import { Sparkles, ArrowUpRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

// ─── PremiumCard ────────────────────────────────────────────────────

export const PremiumCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    /** Disable the hover lift. Use for purely informational containers. */
    interactive?: boolean;
    /** Tighter inner padding for compact contexts. */
    compact?: boolean;
  }
>(function PremiumCard({ className, interactive = true, compact = false, ...rest }, ref) {
  return (
    <div
      ref={ref}
      {...rest}
      className={cn(
        "rounded-2xl border border-border bg-surface shadow-soft transition-all duration-200 ease-out",
        compact ? "p-4" : "p-5 sm:p-6",
        interactive && "hover:-translate-y-0.5 hover:shadow-lift hover:border-border-strong",
        className
      )}
    />
  );
});

// ─── MetricCard (KPI) ───────────────────────────────────────────────

export type MetricTone = "brand" | "positive" | "warning" | "neutral";

export function MetricCard({
  label,
  value,
  icon: Icon,
  tone = "brand",
  trend,
  sparkline,
  muted,
  className,
}: {
  label: string;
  value: React.ReactNode;
  icon: LucideIcon;
  tone?: MetricTone;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  sparkline?: React.ReactNode;
  muted?: boolean;
  className?: string;
}) {
  const toneStyles: Record<MetricTone, { bg: string; text: string; ring: string }> = {
    brand:    { bg: "bg-brand-subtle",       text: "text-brand-accent", ring: "ring-brand-accent/15" },
    positive: { bg: "bg-emerald-50",         text: "text-emerald-600",  ring: "ring-emerald-300/30" },
    warning:  { bg: "bg-amber-50",           text: "text-amber-600",    ring: "ring-amber-300/40" },
    neutral:  { bg: "bg-surface-inset",      text: "text-ink-subtle",   ring: "ring-transparent" },
  };
  const t = toneStyles[tone];

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-soft transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:shadow-lift hover:border-border-strong",
        muted && "bg-surface-subtle",
        className
      )}
    >
      {/* Layered icon container — soft glow ring + tonal background */}
      <div
        aria-hidden
        className={cn(
          "absolute right-5 top-5 inline-flex h-10 w-10 items-center justify-center rounded-xl ring-1 transition-all duration-200 group-hover:scale-105",
          t.bg,
          t.text,
          t.ring
        )}
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </div>

      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-subtle">
        {label}
      </div>
      <div className="mt-2.5 text-[32px] font-semibold leading-none tracking-tight tabular-nums text-ink">
        {value}
      </div>

      {(trend || sparkline) && (
        <div className="mt-4 flex items-end justify-between gap-3">
          {trend && (
            <TrendPill direction={trend.direction} label={trend.label} />
          )}
          {sparkline && <div className="flex-1 self-stretch opacity-70">{sparkline}</div>}
        </div>
      )}
    </div>
  );
}

function TrendPill({ direction, label }: { direction: "up" | "down" | "flat"; label: string }) {
  const arrow = direction === "up" ? "↗" : direction === "down" ? "↘" : "→";
  const styles =
    direction === "up"
      ? "bg-emerald-50 text-emerald-700"
      : direction === "down"
        ? "bg-red-50 text-red-700"
        : "bg-surface-inset text-ink-subtle";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums transition-transform duration-200 group-hover:scale-105",
        styles
      )}
    >
      <span className="text-[10px]">{arrow}</span>
      {label}
    </span>
  );
}

// ─── GlassCard ──────────────────────────────────────────────────────

export function GlassCard({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn(
        "rounded-2xl border border-border/60 bg-surface/70 p-5 shadow-soft backdrop-blur-xl transition-all duration-200 ease-out hover:bg-surface/85",
        className
      )}
    >
      {children}
    </div>
  );
}

// ─── InsightCard ────────────────────────────────────────────────────

export function InsightCard({
  title = "AI Insight",
  children,
  className,
  animated = true,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  animated?: boolean;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-brand-accent/15 p-4 transition-shadow duration-200",
        "bg-gradient-to-br from-brand-subtle via-surface to-surface",
        "shadow-soft hover:shadow-glow",
        className
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-brand-accent/10 blur-3xl"
      />
      <div className="relative flex items-start gap-3">
        <div
          className={cn(
            "mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-accent text-white shadow-sm",
            animated && "zm-pulse-glow"
          )}
        >
          <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-accent">
            {title}
          </div>
          <div className="mt-1 text-[13px] leading-relaxed text-ink">{children}</div>
        </div>
      </div>
    </div>
  );
}

// ─── SectionHeader ──────────────────────────────────────────────────

export function SectionHeader({
  eyebrow,
  title,
  description,
  href,
  hrefLabel,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  href?: string;
  hrefLabel?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-4 flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">
            {eyebrow}
          </div>
        )}
        <h3 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h3>
        {description && (
          <p className="mt-0.5 text-[12px] text-ink-muted">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        {href && hrefLabel && (
          <Link
            href={href}
            className="inline-flex items-center gap-0.5 text-[11px] font-medium text-brand-accent transition-colors hover:text-brand-hover"
          >
            {hrefLabel}
            <ArrowUpRight className="h-3 w-3" strokeWidth={2} />
          </Link>
        )}
      </div>
    </header>
  );
}

// ─── EmptyState (premium) ───────────────────────────────────────────

export function EmptyState({
  icon: Icon,
  title,
  body,
  ctaHref,
  ctaLabel,
  className,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  ctaHref?: string | null;
  ctaLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-gradient-to-b from-surface-subtle to-surface px-4 py-7 text-center",
        className
      )}
    >
      <div className="relative mb-3">
        <div
          aria-hidden
          className="absolute inset-0 rounded-2xl bg-brand-subtle blur-xl"
        />
        <div className="relative inline-flex h-11 w-11 items-center justify-center rounded-2xl border border-brand-accent/15 bg-gradient-to-br from-brand-subtle to-surface text-brand-accent shadow-soft">
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
      </div>
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      <p className="mt-1 max-w-[240px] text-[11px] leading-relaxed text-ink-muted">{body}</p>
      {ctaHref && ctaLabel && (
        <Link
          href={ctaHref}
          className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-accent px-3 text-[12px] font-medium text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-md"
        >
          {ctaLabel}
        </Link>
      )}
    </div>
  );
}
