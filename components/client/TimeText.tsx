"use client";

/**
 * Timezone-aware time renderer for the customer portal.
 *
 * Why this exists:
 *   Every portal page previously rendered dates via
 *   `new Date(iso).toUTCString().slice(...)` — which always showed UTC,
 *   no matter where the customer was. That's a real bug: a 2 PM PT
 *   appointment displayed as "9:00 PM UTC" was disorienting and
 *   eroded trust.
 *
 * What this does:
 *   - On the server (SSR): renders the date formatted in a stable
 *     fallback timezone (defaults to UTC). This gives a deterministic
 *     first paint matching what the server computed.
 *   - On the client (after hydration): re-formats using the browser's
 *     actual timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 *   - Wraps the output in a semantic `<time dateTime={iso}>` so screen
 *     readers + assistive tech see the canonical ISO timestamp.
 *
 * Why `suppressHydrationWarning`:
 *   The visible text intentionally differs between SSR and the
 *   post-hydration re-render (different timezones). React warns about
 *   this; the warning is suppressed where it's expected. The DOM
 *   attribute `dateTime` carries the canonical ISO regardless.
 *
 * Hardened defaults:
 *   - If `iso` is invalid, falls back to the raw string (no throw).
 *   - If `Intl.DateTimeFormat()` returns an empty timezone (rare),
 *     falls back to the supplied `fallbackTz`.
 *
 * Booking-engine guarantee:
 *   This component only reads + formats. It never mutates booking data
 *   or the database state. The booking engine continues to store UTC
 *   timestamps; only the display layer changes.
 */
import { useEffect, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";

export type TimeTextProps = {
  /** Canonical ISO-8601 string. Booking engine always emits UTC. */
  iso: string;
  /** date-fns format pattern. Examples: "EEE, MMM d · h:mm a". */
  format: string;
  /** Timezone used on SSR before hydration. Defaults to "UTC". */
  fallbackTz?: string;
  className?: string;
};

function safeFormat(iso: string, tz: string, format: string): string {
  try {
    return formatInTimeZone(new Date(iso), tz, format);
  } catch {
    return iso;
  }
}

export function TimeText({ iso, format, fallbackTz = "UTC", className }: TimeTextProps) {
  const ssrText = safeFormat(iso, fallbackTz, format);
  const [text, setText] = useState<string>(ssrText);

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone || fallbackTz;
    setText(safeFormat(iso, detected, format));
  }, [iso, format, fallbackTz]);

  return (
    <time dateTime={iso} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}

/**
 * Renders the visitor's current IANA timezone string.
 * SSR: shows `fallback`. Post-hydration: shows the detected zone.
 */
export function TimeZoneText({
  fallback = "UTC",
  className,
}: {
  fallback?: string;
  className?: string;
}) {
  const [tz, setTz] = useState<string>(fallback);
  useEffect(() => {
    setTz(Intl.DateTimeFormat().resolvedOptions().timeZone || fallback);
  }, [fallback]);
  return (
    <span className={className} suppressHydrationWarning>
      {tz}
    </span>
  );
}
