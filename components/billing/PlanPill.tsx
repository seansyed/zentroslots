"use client";

/**
 * Compact plan badge — "Pro plan", "Free — upgrade", etc.
 *
 * Reads from the CapabilityProvider. Renders nothing when no provider
 * is mounted (consistent with the fail-closed posture — a missing
 * plan signal shouldn't show a misleading badge).
 */
import * as React from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";

import { usePlanCapabilities } from "./CapabilityProvider";
import { cn } from "@/lib/cn";

export function PlanPill({
  /** Show an "Upgrade" link when the plan is free. Defaults true. */
  upgradeCta = true,
  /** Optional class override for layout in tight contexts. */
  className,
}: {
  upgradeCta?: boolean;
  className?: string;
}) {
  const { payload } = usePlanCapabilities();
  if (!payload) return null;
  const { plan } = payload;
  const isFree = plan.id === "free";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.10em] ring-1",
        isFree
          ? "bg-surface-inset text-ink-muted ring-border/40"
          : "bg-brand-subtle text-brand-accent ring-brand-accent/20",
        className,
      )}
      title={`Workspace plan: ${plan.name}`}
    >
      <Sparkles className="h-2.5 w-2.5" strokeWidth={2.25} />
      {plan.name} plan
      {isFree && upgradeCta ? (
        <Link
          href="/dashboard/billing"
          className="ml-1 underline-offset-2 hover:underline"
        >
          Upgrade
        </Link>
      ) : null}
    </span>
  );
}
