"use client";

/**
 * AnimatedCounter — tasteful number tween for KPI cards.
 *
 * Tweens from 0 (or `from`) to `value` over `durationMs` using an
 * ease-out cubic. Respects prefers-reduced-motion (snaps to final
 * value without tweening).
 *
 * Use sparingly — only on hero KPIs, never on every count in a list.
 * Motion philosophy: invisible, expensive-feeling, no bounces.
 *
 *   <AnimatedCounter value={mrrCents} format={(n) => fmtCurrency(n)} />
 *
 * Performance: 60fps target via requestAnimationFrame. Cleans up
 * its rAF on unmount.
 */

import * as React from "react";
import { useReducedMotion } from "framer-motion";

type Props = {
  /** Final numeric value. */
  value: number;
  /** Starting value (defaults to 0 on first mount, prev value on update). */
  from?: number;
  /** Tween duration in ms. Default 700. */
  durationMs?: number;
  /** Number → display string. Default: en-US grouping. */
  format?: (n: number) => string;
  className?: string;
};

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const defaultFormat = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));

export function AnimatedCounter({
  value,
  from,
  durationMs = 700,
  format = defaultFormat,
  className,
}: Props) {
  const reduced = useReducedMotion();
  const prevRef = React.useRef<number>(from ?? 0);
  const [display, setDisplay] = React.useState<number>(reduced ? value : prevRef.current);
  const rafRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (reduced) {
      setDisplay(value);
      prevRef.current = value;
      return;
    }
    const start = prevRef.current;
    const end = value;
    if (start === end) return;
    const t0 = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      const v = start + (end - start) * easeOutCubic(t);
      setDisplay(v);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(end);
        prevRef.current = end;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs, reduced]);

  // Use a tabular-figures variant so digits don't shift width as they change.
  return (
    <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {format(display)}
    </span>
  );
}
