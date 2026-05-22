"use client";

/**
 * Full-card locked state — used when an entire feature page or
 * hero section should be replaced with a clear upgrade prompt.
 *
 * For inline gates (button rows, form sections), use `UpgradeGate`.
 *
 * Fail-closed: same posture as the other primitives.
 */
import * as React from "react";
import Link from "next/link";
import { Lock, Sparkles } from "lucide-react";

import { useCapability, type Capability } from "./CapabilityProvider";
import { PremiumCard } from "@/components/ui/Card";
import { cn } from "@/lib/cn";

export function LockedFeatureCard({
  cap,
  /** Title of the locked feature, as the user knows it
   *  ("Recurring scheduling", "Workflow automations"). */
  title,
  /** Short description / value proposition. Stays honest — do not
   *  promise capabilities the plan tier doesn't actually deliver. */
  description,
  upgradeHref = "/dashboard/billing",
  /** When true, render the children below the upgrade block — useful
   *  to show a disabled preview of the feature alongside the prompt. */
  children,
  className,
}: {
  cap: Capability;
  title: string;
  description: string;
  upgradeHref?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const check = useCapability(cap);
  if (check.allowed) return <>{children}</>;

  const requiredLabel = check.requiredPlan.charAt(0).toUpperCase() + check.requiredPlan.slice(1);

  return (
    <PremiumCard
      compact
      interactive={false}
      className={cn(
        "relative overflow-hidden bg-gradient-to-br from-surface-inset/60 via-surface to-surface",
        className,
      )}
    >
      <div className="relative flex flex-wrap items-start gap-4 sm:flex-nowrap">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-surface ring-1 ring-border/60">
          <Lock className="h-5 w-5 text-ink-muted" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-brand-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-brand-accent">
            <Sparkles className="h-3 w-3" strokeWidth={2.25} />
            {requiredLabel}+ feature
          </div>
          <h2 className="mt-2 text-[18px] font-semibold tracking-tight text-ink">
            {title}
          </h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
            {description}
          </p>
          <p className="mt-2 text-[12px] text-ink-muted/85">{check.reason}</p>
          <Link
            href={upgradeHref}
            className="mt-3 inline-flex items-center gap-1 rounded-full bg-brand-accent px-3 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-accent/90"
          >
            See plans
          </Link>
        </div>
      </div>
    </PremiumCard>
  );
}
