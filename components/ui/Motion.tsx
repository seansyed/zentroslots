"use client";

/**
 * Tiny Framer Motion wrappers (Phase 2).
 *
 * Used at section boundaries on the dashboard so the page entrance
 * feels alive without making every component client-side. Server
 * components render their content; the motion wrapper just animates
 * the wrapper div.
 *
 * Motion philosophy: invisible. No bounces, no spring chains, no
 * eye-catching choreography. Everything is short (140–220ms), eases
 * out, and respects prefers-reduced-motion.
 *
 *   <StaggerContainer>
 *     <FadeIn delay={0}>...</FadeIn>
 *     <FadeIn delay={1}>...</FadeIn>
 *   </StaggerContainer>
 *
 * `delay` is an index, not seconds — actual ms are computed from
 * STAGGER_BASE so the cadence stays consistent globally.
 */
import * as React from "react";
import { motion, useReducedMotion, type Variants } from "framer-motion";

const STAGGER_BASE_MS = 60;
const ANIM_DURATION = 0.22;

export function StaggerContainer({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={className}>{children}</div>;
}

export function FadeIn({
  children,
  delay = 0,
  className,
  y = 8,
  as = "div",
}: {
  children: React.ReactNode;
  /** Index-based delay (multiplied by STAGGER_BASE_MS). */
  delay?: number;
  className?: string;
  /** Pixels of upward motion. Default 8. */
  y?: number;
  as?: "div" | "section" | "header" | "aside" | "article";
}) {
  const reduced = useReducedMotion();
  const variants: Variants = reduced
    ? { hidden: { opacity: 1 }, visible: { opacity: 1 } }
    : {
        hidden: { opacity: 0, y },
        visible: {
          opacity: 1,
          y: 0,
          transition: {
            duration: ANIM_DURATION,
            ease: [0.16, 1, 0.3, 1], // cubic-bezier easeOutExpo-ish
            delay: (delay * STAGGER_BASE_MS) / 1000,
          },
        },
      };

  const MotionTag = motion[as] as React.ComponentType<
    React.HTMLAttributes<HTMLElement> & { variants?: Variants; initial?: string; animate?: string }
  >;

  return (
    <MotionTag
      className={className}
      variants={variants}
      initial="hidden"
      animate="visible"
    >
      {children}
    </MotionTag>
  );
}

/**
 * Shimmer loading skeleton — pure CSS animation triggered by the
 * `.zm-shimmer` class defined in globals.css. Exposed here so callers
 * import a single ergonomic component instead of remembering the class.
 */
export function Skeleton({
  className,
  rounded = "rounded-lg",
}: {
  className?: string;
  rounded?: string;
}) {
  return (
    <div
      aria-hidden
      className={`relative overflow-hidden bg-surface-inset zm-shimmer ${rounded} ${className ?? ""}`}
    />
  );
}
