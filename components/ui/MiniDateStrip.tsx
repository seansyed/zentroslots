"use client";

/**
 * MiniDateStrip — compact horizontal date scroller.
 *
 * Shows 7 consecutive days centered on a target date. Today gets a
 * brand-accent treatment, dates with bookings get a small dot
 * indicator beneath the number.
 *
 * Clicking a date scrolls the page to the corresponding section
 * (#yyyy-mm-dd anchor) — purely client-side, no data refetch.
 */
import * as React from "react";
import { formatInTimeZone } from "date-fns-tz";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

export default function MiniDateStrip({
  timezone,
  datesWithBookings,
  className,
}: {
  timezone: string;
  /** Set of YYYY-MM-DD strings that have at least one booking. Used to
   *  show the dot indicator under the day number. */
  datesWithBookings?: Set<string>;
  className?: string;
}) {
  const [anchorDate, setAnchorDate] = React.useState<Date>(() => new Date());

  const days = React.useMemo(() => {
    const out: Date[] = [];
    const start = new Date(anchorDate);
    start.setDate(start.getDate() - 3);
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }, [anchorDate]);

  function shiftDays(delta: number) {
    setAnchorDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + delta);
      return next;
    });
  }

  function dayKey(d: Date): string {
    return formatInTimeZone(d, timezone, "yyyy-MM-dd");
  }

  function onPickDate(d: Date) {
    // Scroll the page to the date section if it exists; otherwise just
    // re-anchor the strip.
    setAnchorDate(d);
    const id = dayKey(d);
    const target = document.getElementById(`agenda-${id}`);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  const todayKey = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-soft",
        className
      )}
    >
      <button
        type="button"
        onClick={() => shiftDays(-7)}
        aria-label="Previous week"
        className="inline-flex h-9 w-7 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
      </button>

      <div className="flex flex-1 justify-between gap-0.5">
        {days.map((d) => {
          const key = dayKey(d);
          const isToday = key === todayKey;
          const hasBookings = datesWithBookings?.has(key) ?? false;
          const weekday = formatInTimeZone(d, timezone, "EEE").slice(0, 1);
          const day = formatInTimeZone(d, timezone, "d");
          return (
            <button
              key={key}
              type="button"
              onClick={() => onPickDate(d)}
              className={cn(
                "group flex h-9 flex-col items-center justify-center rounded-lg px-2.5 transition-all duration-150",
                isToday
                  ? "bg-brand-accent text-white shadow-soft"
                  : "text-ink-muted hover:bg-surface-inset hover:text-ink"
              )}
              title={formatInTimeZone(d, timezone, "EEEE, MMM d")}
            >
              <span
                className={cn(
                  "text-[9px] font-semibold uppercase tracking-wider leading-none",
                  isToday ? "text-white/80" : "text-ink-subtle"
                )}
              >
                {weekday}
              </span>
              <span
                className={cn(
                  "mt-0.5 text-[12px] font-semibold tabular-nums leading-none",
                  isToday ? "text-white" : "text-ink"
                )}
              >
                {day}
              </span>
              {hasBookings && !isToday && (
                <span aria-hidden className="mt-0.5 h-1 w-1 rounded-full bg-brand-accent" />
              )}
              {hasBookings && isToday && (
                <span aria-hidden className="mt-0.5 h-1 w-1 rounded-full bg-white" />
              )}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => shiftDays(7)}
        aria-label="Next week"
        className="inline-flex h-9 w-7 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-inset hover:text-ink"
      >
        <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
      </button>
    </div>
  );
}
