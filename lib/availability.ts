import { and, eq, gte, lt } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { addDays, addMinutes, areIntervalsOverlapping, parseISO } from "date-fns";

import { db } from "@/db/client";
import {
  availability,
  availabilityOverrides,
  bookings,
  services,
  users,
} from "@/db/schema";
import { getExternalBusyForUser } from "@/lib/calendar/sync";

const SLOT_INTERVAL_MINUTES = 15;

type Interval = { start: Date; end: Date };

// ─── Public API ─────────────────────────────────────────────────────────
// Signature unchanged. Behavior is a strict superset of the original:
// with no overrides present, output is byte-identical.

export async function getAvailableSlots(params: {
  staffUserId: string;
  serviceId: string;
  date: string;
  timezone: string;
}): Promise<string[]> {
  const { staffUserId, serviceId, date, timezone } = params;

  const [staff, service] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, staffUserId) }),
    db.query.services.findFirst({ where: eq(services.id, serviceId) }),
  ]);

  if (!staff) throw new Error("Staff not found");
  if (!service) throw new Error("Service not found");
  if (service.isActive !== 1) return [];

  const viewerDay = getDayWindowUtc(date, timezone);

  // NEW: returns an array of intervals (split-day support, override aware).
  const workingWindows = await getStaffWorkingWindows(staffUserId, date, staff.timezone);
  if (workingWindows.length === 0) return [];

  // Intersect each working window with the viewer's day window; drop empties.
  const bookable = workingWindows
    .map((w) => intersect(viewerDay, w))
    .filter((w): w is Interval => w !== null);
  if (bookable.length === 0) return [];

  // Combine internal bookings + external calendar busy time. The
  // external lookup is no-op for staff without an active Google
  // connection — output is then byte-identical to the pre-feature
  // behavior. Freebusy is also wrapped in try/catch inside the
  // orchestrator so a Google API failure can't break availability.
  const [existing, externalBusy] = await Promise.all([
    getBookingsInRange(staffUserId, viewerDay),
    getExternalBusyForUser(staffUserId, viewerDay.start, viewerDay.end),
  ]);
  const combinedBusy: Interval[] = [...existing, ...externalBusy];

  // Walk every window independently and concatenate.
  const all: string[] = [];
  for (const window of bookable) {
    const slots = buildSlots({
      window,
      durationMinutes: service.durationMinutes,
      bufferBefore: service.bufferBefore,
      bufferAfter: service.bufferAfter,
      existing: combinedBusy,
    });
    all.push(...slots);
  }
  return all;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getDayWindowUtc(date: string, timezone: string): Interval {
  const start = fromZonedTime(`${date}T00:00:00`, timezone);
  const nextDay = addDays(parseISO(`${date}T00:00:00Z`), 1)
    .toISOString()
    .slice(0, 10);
  const end = fromZonedTime(`${nextDay}T00:00:00`, timezone);
  return { start, end };
}

/**
 * Returns the staff's effective working windows for the given date.
 * Resolution order:
 *   1. If any override row for that date has unavailable=true → []
 *      (full-day block; vacations/holidays)
 *   2. Otherwise, if there are override rows with hours, those REPLACE
 *      the weekly recurring rule (supports split-day, e.g. 9–12 + 1–5)
 *   3. Otherwise, fall back to the single weekly availability row.
 */
async function getStaffWorkingWindows(
  staffUserId: string,
  date: string,
  staffTimezone: string
): Promise<Interval[]> {
  const overrides = await db
    .select({
      unavailable: availabilityOverrides.unavailable,
      startTime: availabilityOverrides.startTime,
      endTime: availabilityOverrides.endTime,
    })
    .from(availabilityOverrides)
    .where(
      and(
        eq(availabilityOverrides.userId, staffUserId),
        eq(availabilityOverrides.date, date)
      )
    );

  // Rule 1: any full-day block wins.
  if (overrides.some((o) => o.unavailable)) return [];

  // Rule 2: replace with override windows if present.
  if (overrides.length > 0) {
    const windows: Interval[] = [];
    for (const o of overrides) {
      if (!o.startTime || !o.endTime) continue;
      windows.push({
        start: fromZonedTime(`${date}T${o.startTime}`, staffTimezone),
        end: fromZonedTime(`${date}T${o.endTime}`, staffTimezone),
      });
    }
    return windows;
  }

  // Rule 3: fall back to weekly rule (single window).
  const dayOfWeek = getDayOfWeekInTimezone(date, staffTimezone);
  const rule = await db.query.availability.findFirst({
    where: and(
      eq(availability.userId, staffUserId),
      eq(availability.dayOfWeek, dayOfWeek)
    ),
  });
  if (!rule) return [];

  return [
    {
      start: fromZonedTime(`${date}T${rule.startTime}`, staffTimezone),
      end: fromZonedTime(`${date}T${rule.endTime}`, staffTimezone),
    },
  ];
}

function getDayOfWeekInTimezone(date: string, timezone: string): number {
  const anchor = fromZonedTime(`${date}T12:00:00`, timezone);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: timezone,
  }).format(anchor);
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[weekday];
}

async function getBookingsInRange(
  staffUserId: string,
  window: Interval
): Promise<Interval[]> {
  const rows = await db
    .select({ startAt: bookings.startAt, endAt: bookings.endAt })
    .from(bookings)
    .where(
      and(
        eq(bookings.staffUserId, staffUserId),
        eq(bookings.status, "confirmed"),
        gte(bookings.endAt, window.start),
        lt(bookings.startAt, window.end)
      )
    );
  return rows.map((r) => ({ start: r.startAt, end: r.endAt }));
}

function intersect(a: Interval, b: Interval): Interval | null {
  const start = a.start > b.start ? a.start : b.start;
  const end = a.end < b.end ? a.end : b.end;
  return start < end ? { start, end } : null;
}

function buildSlots(args: {
  window: Interval;
  durationMinutes: number;
  bufferBefore: number;
  bufferAfter: number;
  existing: Interval[];
}): string[] {
  const { window, durationMinutes, bufferBefore, bufferAfter, existing } = args;

  const now = new Date();
  const slots: string[] = [];

  const blocked = existing.map((b) => ({
    start: addMinutes(b.start, -bufferBefore),
    end: addMinutes(b.end, bufferAfter),
  }));

  let cursor = window.start;
  while (true) {
    const slotStart = cursor;
    const slotEnd = addMinutes(slotStart, durationMinutes);
    if (slotEnd > window.end) break;

    const footprintStart = addMinutes(slotStart, -bufferBefore);
    const footprintEnd = addMinutes(slotEnd, bufferAfter);

    const inPast = slotStart <= now;
    const collides = blocked.some((b) =>
      areIntervalsOverlapping(
        { start: footprintStart, end: footprintEnd },
        b,
        { inclusive: false }
      )
    );

    if (!inPast && !collides) {
      slots.push(slotStart.toISOString());
    }

    cursor = addMinutes(cursor, SLOT_INTERVAL_MINUTES);
  }

  return slots;
}
