"use client";

/**
 * Inline upgrade prompt — replaces a small UI region (a form, a
 * button row, a single section) with a compact locked-state hint
 * when the capability is unavailable on the current plan.
 *
 * For full-card / hero-style upgrade panels, use `LockedFeatureCard`.
 *
 * Fail-closed: a missing provider renders the locked state. UX is
 * intentional — a Free tenant should never see premium UI just
 * because the page forgot to mount the provider.
 */
import * as React from "react";
import Link from "next/link";
import { Lock } from "lucide-react";

import { useCapability, type Capability } from "./CapabilityProvider";
import { cn } from "@/lib/cn";

export function UpgradeGate({
  cap,
  children,
  /** Visible label for the locked variant. Defaults to the
   *  capability's server-resolved reason string. */
  message,
  /** href for the upgrade CTA. */
  upgradeHref = "/dashboard/billing",
  /** Compact rendering for tight contexts (chips in toolbars, etc.). */
  size = "default",
  className,
}: {
  cap: Capability;
  children: React.ReactNode;
  message?: string;
  upgradeHref?: string;
  size?: "default" | "sm";
  className?: string;
}) {
  const check = useCapability(cap);
  if (check.allowed) return <>{children}</>;

  return (
    <div
      role="region"
      aria-label="Feature locked — upgrade required"
      className={cn(
        "rounded-xl border border-dashed border-border bg-surface-inset/60 p-4 text-sm text-ink-muted",
        size === "sm" && "p-3 text-[12px]",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface ring-1 ring-border/60">
          <Lock className="h-3.5 w-3.5 text-ink-muted" strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">{message ?? check.reason}</p>
          <Link
            href={upgradeHref}
            className="mt-1 inline-flex items-center text-[12px] font-semibold text-brand-accent hover:underline"
          >
            See plans →
          </Link>
        </div>
      </div>
    </div>
  );
}
