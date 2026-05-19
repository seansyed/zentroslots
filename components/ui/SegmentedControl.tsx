"use client";

/**
 * SegmentedControl — premium filter pills with an animated active
 * indicator powered by Framer Motion's shared layoutId.
 *
 *   <SegmentedControl
 *     items={[{value:"all", label:"All", count:42}, ...]}
 *     value={current}
 *     onChange={(v) => router.push(`?status=${v}`)}
 *   />
 *
 * The active background slides between items with a 220ms spring-free
 * tween (per Phase 2 motion rules). Each segment can carry an optional
 * count badge.
 */
import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/cn";

export type Segment = {
  value: string;
  label: string;
  /** Optional count badge to the right of the label. */
  count?: number | null;
  /** Optional Lucide icon component rendered before the label. */
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
};

export default function SegmentedControl({
  items,
  value,
  onChange,
  layoutGroupId,
  size = "md",
  className,
}: {
  items: Segment[];
  value: string;
  onChange: (next: string) => void;
  /** Required when multiple SegmentedControls render on the same page —
   *  otherwise their indicators would attempt to share layoutId. */
  layoutGroupId?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const reduced = useReducedMotion();
  const indicatorId = `seg-active-${layoutGroupId ?? "default"}`;

  const px = size === "sm" ? "px-2.5" : "px-3.5";
  const py = size === "sm" ? "py-1" : "py-1.5";
  const text = size === "sm" ? "text-[11px]" : "text-[12px]";

  return (
    <div
      className={cn(
        "inline-flex flex-wrap items-center gap-0.5 rounded-xl border border-border bg-surface-subtle p-1 shadow-soft",
        className
      )}
      role="tablist"
    >
      {items.map((seg) => {
        const active = seg.value === value;
        const Icon = seg.icon;
        return (
          <button
            key={seg.value || "all"}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(seg.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors duration-150",
              px,
              py,
              text,
              active ? "text-brand-accent" : "text-ink-muted hover:text-ink"
            )}
          >
            {active && (
              <motion.span
                layoutId={indicatorId}
                aria-hidden
                className="absolute inset-0 rounded-lg bg-surface shadow-soft ring-1 ring-border"
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: "tween", duration: 0.18, ease: [0.16, 1, 0.3, 1] }
                }
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />}
              <span>{seg.label}</span>
              {typeof seg.count === "number" && seg.count > 0 && (
                <span
                  className={cn(
                    "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold tabular-nums",
                    active ? "bg-brand-subtle text-brand-accent" : "bg-surface-inset text-ink-subtle"
                  )}
                >
                  {seg.count}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
