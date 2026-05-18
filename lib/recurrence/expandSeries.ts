/**
 * Expand a RecurrenceRule into concrete UTC start instants.
 *
 * Inputs:
 *   - rule:       parsed RecurrenceRule
 *   - startLocal: "YYYY-MM-DDTHH:MM:SS" wall-clock anchor in `timezone`
 *   - timezone:   IANA TZ ("America/Los_Angeles")
 *   - windowEnd:  hard upper bound (UTC) the worker won't materialize past
 *   - startIndex: which 0-indexed occurrence to start from (resume support)
 *   - maxCount:   safety cap on returned occurrences (caller-supplied)
 *
 * Returns: array of { index, startAt: Date } in chronological order.
 *
 * Wall-clock preserving: DST shifts keep the local clock-time stable
 * (a "weekly Tuesday at 10am" rule stays at 10am local even across
 * DST boundaries). This matches user expectation for recurring
 * appointments.
 *
 * Pure — no DB, no side effects. The materializer turns these instants
 * into occurrence rows.
 */
import type { RecurrenceRule, Weekday } from "./types";
import { WEEKDAY_TO_INDEX } from "./types";

export type ExpandedOccurrence = {
  index: number;
  startAt: Date;
};

export type ExpandArgs = {
  rule: RecurrenceRule;
  startLocal: string;
  timezone: string;
  windowEnd: Date;
  startIndex?: number;
  maxCount?: number;
};

export function expandSeries(args: ExpandArgs): ExpandedOccurrence[] {
  const startIndex = args.startIndex ?? 0;
  const maxCount = args.maxCount ?? 200;
  const out: ExpandedOccurrence[] = [];

  // Parse the anchor's local wall-clock components.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(args.startLocal);
  if (!m) return out; // garbage anchor — defensive; caller validates upstream
  const [, ys, mos, ds, hs, mis, ses] = m;
  const anchorY = Number(ys);
  const anchorMo = Number(mos) - 1;
  const anchorD = Number(ds);
  const anchorH = Number(hs);
  const anchorMi = Number(mis);
  const anchorSe = Number(ses);

  // For WEEKLY w/o BYDAY we anchor on the wall-clock weekday of startLocal.
  const anchorWeekdayIdx = jsWeekdayOf(anchorY, anchorMo, anchorD);

  // BYDAY indices into JS getDay() space.
  const bydayIndices: number[] | null =
    args.rule.byday && args.rule.byday.length > 0
      ? args.rule.byday.map((w: Weekday) => WEEKDAY_TO_INDEX[w]).sort((a, b) => a - b)
      : null;

  // Iterate. We walk through indices >= 0, computing the local-date
  // for occurrence i, then mapping wall-clock to UTC via the TZ.
  // For DAILY/MONTHLY: i-th occurrence = anchor + i*INTERVAL (units).
  // For WEEKLY w/ BYDAY: we enumerate days within weeks.
  let i = 0;
  let emitted = 0;
  let weekStart = 0; // for WEEKLY iteration
  const HARD_CAP = 5000; // absolute safety stop

  for (let safety = 0; safety < HARD_CAP; safety++) {
    let occLocal: { y: number; mo: number; d: number } | null = null;

    if (args.rule.freq === "DAILY") {
      const offsetDays = i * args.rule.interval;
      occLocal = addDays(anchorY, anchorMo, anchorD, offsetDays);
    } else if (args.rule.freq === "WEEKLY") {
      if (!bydayIndices) {
        // No BYDAY: fire once per (INTERVAL * 7) days, on the anchor weekday.
        const offsetDays = i * args.rule.interval * 7;
        occLocal = addDays(anchorY, anchorMo, anchorD, offsetDays);
      } else {
        // BYDAY present: within the current "active week", iterate through
        // bydayIndices producing occurrences on those days.
        // weekStart is the local date of the Monday of the active week.
        // We index from 0 = week-of-anchor; week k = week-of-anchor +
        // k*INTERVAL weeks; within that week the days at bydayIndices
        // produce occurrences in order.
        const weekIndex = Math.floor(i / bydayIndices.length);
        const dayInWeek = i % bydayIndices.length;
        const weekOffsetDays = weekIndex * args.rule.interval * 7;
        const baseWeekday = anchorWeekdayIdx; // JS weekday 0..6
        const targetWeekday = bydayIndices[dayInWeek];
        // Day delta from anchor to the target weekday in week `weekIndex`.
        // Anchor day is at offset 0; first day of anchor's week (Sunday=0)
        // is at offset -baseWeekday. From there, targetWeekday lands at
        // (-baseWeekday + targetWeekday). Then add weekOffsetDays.
        const offsetDays = -baseWeekday + targetWeekday + weekOffsetDays;
        // Negative offsets mean "before anchor" — skip those (rule starts
        // at anchor or later).
        if (offsetDays < 0) {
          i++;
          continue;
        }
        occLocal = addDays(anchorY, anchorMo, anchorD, offsetDays);
      }
    } else if (args.rule.freq === "MONTHLY") {
      const offsetMonths = i * args.rule.interval;
      occLocal = addMonths(anchorY, anchorMo, anchorD, offsetMonths);
    }

    if (!occLocal) break;

    // Map local wall-clock to UTC.
    const localStr =
      String(occLocal.y).padStart(4, "0") + "-" +
      String(occLocal.mo + 1).padStart(2, "0") + "-" +
      String(occLocal.d).padStart(2, "0") + "T" +
      String(anchorH).padStart(2, "0") + ":" +
      String(anchorMi).padStart(2, "0") + ":" +
      String(anchorSe).padStart(2, "0");
    const utc = localWallClockToUtc(localStr, args.timezone);

    // Stop conditions.
    if (args.rule.until && utc > args.rule.until) break;
    if (args.rule.count && i >= args.rule.count) break;
    if (utc > args.windowEnd) break;

    if (i >= startIndex) {
      out.push({ index: i, startAt: utc });
      emitted++;
      if (emitted >= maxCount) break;
    }
    i++;

    void weekStart; // reserved if we ever need explicit week marching
  }

  return out;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function addDays(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const dt = new Date(Date.UTC(y, mo, d + n));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate() };
}

function addMonths(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  // Same-day-next-month, clamped for short months (Jan 31 + 1mo = Feb 28/29).
  const targetMo = mo + n;
  const dt = new Date(Date.UTC(y, targetMo, 1));
  const daysInTarget = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  const clampedDay = Math.min(d, daysInTarget);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: clampedDay };
}

function jsWeekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo, d)).getUTCDay();
}

/**
 * Convert a local wall-clock string ("YYYY-MM-DDTHH:MM:SS") in a target
 * IANA timezone to UTC. Approach: compute the offset at that moment via
 * Intl.DateTimeFormat and walk it back. Same approach used elsewhere in
 * the codebase (lib/booking-rules/validateBookingRules, lib/routing/
 * eligibility).
 */
export function localWallClockToUtc(local: string, timezone: string): Date {
  const guess = new Date(local + "Z");
  const localFromUtc = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const get = (t: string) => Number(localFromUtc.find((p) => p.type === t)?.value ?? "0");
  const back = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  const diff = guess.getTime() - back;
  return new Date(guess.getTime() + diff);
}
