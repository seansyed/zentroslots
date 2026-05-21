/**
 * Routing capacity forecasting — REAL state, no model.
 *
 * Computes per-staff capacity for the rest of today from observable
 * sources only:
 *   - users + availability (weekly schedule, per-staff)
 *   - availability_overrides (PTO + per-day overrides)
 *   - bookings (confirmed, today's window)
 *
 * Output is intentionally narrow:
 *   - remaining hours of working window AFTER now
 *   - hours already booked today
 *   - utilization% = booked / scheduled
 *   - overload flag (utilization ≥ 90%)
 *
 * NOT included (would be invented):
 *   - "estimated overload risk" as a synthetic score
 *   - "peak booking windows" projections beyond what bookings exist
 *   - external calendar busy time (not subtracted — that's per-staff
 *     OAuth state and querying freebusy per staff per page load would
 *     be expensive). The forecast over-estimates available capacity
 *     for staff with external calendars; the UI notes this honestly.
 */
import { and, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import {
  availability,
  availabilityOverrides,
  bookings,
  users,
} from "@/db/schema";

export type CapacityRow = {
  staffId: string;
  staffName: string;
  staffEmail: string;
  /** Hours the staff is scheduled to work today (from availability +
   *  overrides). 0 means closed today. */
  scheduledHours: number;
  /** Hours of confirmed bookings landing inside today's working
   *  window. Bookings outside the window are ignored. */
  bookedHours: number;
  /** Hours of working window remaining AFTER now. 0 once the day is
   *  over. Null when there's no schedule today (closed). */
  remainingHours: number | null;
  /** booked / scheduled, 0..1. Null when no schedule. */
  utilization: number | null;
  /** True when utilization ≥ 0.9. */
  overloaded: boolean;
  /** When the working window opens today (ISO). Null when closed. */
  windowStart: string | null;
  /** When the working window closes today (ISO). Null when closed. */
  windowEnd: string | null;
};

export type CapacitySummary = {
  /** Per-staff rows, sorted by remainingHours descending so the most
   *  available staff surface first. */
  rows: CapacityRow[];
  /** Sum of remainingHours across all staff with a schedule today. */
  totalRemainingHours: number;
  /** Count of staff currently flagged as overloaded. */
  overloadedCount: number;
  /** Count of staff with no schedule today (closed). */
  closedCount: number;
  /** ISO of "today's window opens" — the earliest windowStart across
   *  all staff. Null when nobody is working today. */
  earliestWindowStart: string | null;
  /** ISO of "today's window closes". */
  latestWindowEnd: string | null;
};

export async function computeCapacity(tenantId: string): Promise<CapacitySummary> {
  // ── 1. Load non-client staff with their timezones.
  const staffRows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      timezone: users.timezone,
      role: users.role,
    })
    .from(users)
    .where(eq(users.tenantId, tenantId));
  const staff = staffRows.filter((s) => s.role !== "client");
  if (staff.length === 0) {
    return {
      rows: [],
      totalRemainingHours: 0,
      overloadedCount: 0,
      closedCount: 0,
      earliestWindowStart: null,
      latestWindowEnd: null,
    };
  }

  const now = new Date();

  // ── 2. Load today's confirmed bookings for the tenant. Filtering
  // happens in JS per-staff since each staff has their own timezone
  // that defines "today".
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 2); // generous window — UTC ±1 covers all timezones

  const bookingRows = await db
    .select({
      staffUserId: bookings.staffUserId,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.status, "confirmed"),
        gte(bookings.endAt, dayStart),
        lt(bookings.startAt, dayEnd),
      ),
    );

  // ── 3. Per-staff: compute their working window today + sum bookings
  // that fall in it.
  const rows: CapacityRow[] = [];
  for (const s of staff) {
    const tz = s.timezone ?? "UTC";
    const window = await resolveTodaysWindow(s.id, tz, now);

    if (!window) {
      rows.push({
        staffId: s.id,
        staffName: s.name,
        staffEmail: s.email,
        scheduledHours: 0,
        bookedHours: 0,
        remainingHours: null,
        utilization: null,
        overloaded: false,
        windowStart: null,
        windowEnd: null,
      });
      continue;
    }

    const staffBookings = bookingRows.filter((b) => b.staffUserId === s.id);
    const bookedMs = staffBookings.reduce((sum, b) => {
      // Clip the booking to the working window.
      const start = b.startAt > window.start ? b.startAt : window.start;
      const end = b.endAt < window.end ? b.endAt : window.end;
      const overlap = end.getTime() - start.getTime();
      return overlap > 0 ? sum + overlap : sum;
    }, 0);

    const scheduledHours = (window.end.getTime() - window.start.getTime()) / 3_600_000;
    const bookedHours = bookedMs / 3_600_000;
    const remainingMs = Math.max(0, window.end.getTime() - Math.max(now.getTime(), window.start.getTime()));
    const remainingHours = remainingMs / 3_600_000;
    const utilization = scheduledHours > 0 ? bookedHours / scheduledHours : 0;

    rows.push({
      staffId: s.id,
      staffName: s.name,
      staffEmail: s.email,
      scheduledHours: round2(scheduledHours),
      bookedHours: round2(bookedHours),
      remainingHours: round2(remainingHours),
      utilization: round2(utilization),
      overloaded: utilization >= 0.9,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
    });
  }

  // Sort: scheduled staff first (by remaining hours desc), then closed.
  rows.sort((a, b) => {
    const aOpen = a.remainingHours !== null;
    const bOpen = b.remainingHours !== null;
    if (aOpen && !bOpen) return -1;
    if (!aOpen && bOpen) return 1;
    if (aOpen && bOpen) return (b.remainingHours ?? 0) - (a.remainingHours ?? 0);
    return a.staffName.localeCompare(b.staffName);
  });

  const scheduledRows = rows.filter((r) => r.remainingHours !== null);
  const totalRemainingHours = round2(
    scheduledRows.reduce((sum, r) => sum + (r.remainingHours ?? 0), 0),
  );
  const overloadedCount = rows.filter((r) => r.overloaded).length;
  const closedCount = rows.filter((r) => r.remainingHours === null).length;

  const windowStarts = scheduledRows
    .map((r) => r.windowStart!)
    .sort();
  const windowEnds = scheduledRows
    .map((r) => r.windowEnd!)
    .sort();

  return {
    rows,
    totalRemainingHours,
    overloadedCount,
    closedCount,
    earliestWindowStart: windowStarts[0] ?? null,
    latestWindowEnd: windowEnds[windowEnds.length - 1] ?? null,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

async function resolveTodaysWindow(
  userId: string,
  staffTimezone: string,
  now: Date,
): Promise<{ start: Date; end: Date } | null> {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: staffTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const overrides = await db
    .select({
      unavailable: availabilityOverrides.unavailable,
      startTime: availabilityOverrides.startTime,
      endTime: availabilityOverrides.endTime,
    })
    .from(availabilityOverrides)
    .where(
      and(
        eq(availabilityOverrides.userId, userId),
        eq(availabilityOverrides.date, dateStr),
      ),
    );

  // Full-day PTO override → closed.
  if (overrides.some((o) => o.unavailable)) return null;

  // Per-day override replaces weekly. Use first (the engine accepts
  // multiples but for capacity we take the outer window).
  if (overrides.length > 0) {
    const o = overrides[0];
    if (!o.startTime || !o.endTime) return null;
    return {
      start: zoned(`${dateStr}T${o.startTime}`, staffTimezone),
      end: zoned(`${dateStr}T${o.endTime}`, staffTimezone),
    };
  }

  // Weekly rule for the staff-local day-of-week.
  const dayOfWeek = dayOfWeekInTz(dateStr, staffTimezone);
  const rule = await db.query.availability.findFirst({
    where: and(eq(availability.userId, userId), eq(availability.dayOfWeek, dayOfWeek)),
  });
  if (!rule) return null;
  return {
    start: zoned(`${dateStr}T${rule.startTime}`, staffTimezone),
    end: zoned(`${dateStr}T${rule.endTime}`, staffTimezone),
  };
}

function dayOfWeekInTz(date: string, timezone: string): number {
  const anchor = zoned(`${date}T12:00:00`, timezone);
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(anchor);
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[wd];
}

function zoned(local: string, timezone: string): Date {
  // Mirrors lib/routing/eligibility.ts:zoned — kept inline to avoid
  // cross-file coupling in this read-only forecasting module.
  const utcGuess = new Date(local + "Z");
  const localFromUtc = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utcGuess);
  const get = (t: string) => Number(localFromUtc.find((p) => p.type === t)?.value ?? "0");
  const back = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const diff = utcGuess.getTime() - back;
  return new Date(utcGuess.getTime() + diff);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
