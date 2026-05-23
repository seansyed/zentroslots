import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import { fromZonedTime } from "date-fns-tz";
import { addDays, addMinutes, areIntervalsOverlapping, parseISO } from "date-fns";

import { db } from "@/db/client";
import {
  availability,
  availabilityOverrides,
  bookings,
  calendarEvents,
  groupSessions,
  services,
  tenants,
  users,
} from "@/db/schema";
import { getExternalBusyForUser } from "@/lib/calendar/sync";
import { loadTenantFeatures } from "@/lib/features";
import {
  readDefaultWorkspaceHours,
  getDefaultForDay,
} from "@/lib/workspace-hours";

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

  // Pass staff.tenantId so getStaffWorkingWindows can resolve the
  // tenant-level default workspace hours fallback (migration 0034).
  // Engine layer above this point doesn't know which layer produced
  // the windows — it only consumes resolved intervals.
  const workingWindows = await getStaffWorkingWindows(
    staffUserId,
    date,
    staff.timezone,
    staff.tenantId,
  );
  if (workingWindows.length === 0) return [];

  // Intersect each working window with the viewer's day window; drop empties.
  const bookable = workingWindows
    .map((w) => intersect(viewerDay, w))
    .filter((w): w is Interval => w !== null);
  if (bookable.length === 0) return [];

  // Combine internal bookings + external calendar busy time + new in
  // Phase 17I-2D: operational calendar_events (blocked time + internal
  // meetings, where this staff is either the organizer OR an
  // attendee). The external lookup is no-op for staff without an
  // active Google connection — output is then byte-identical to the
  // pre-feature behavior. Freebusy is also wrapped in try/catch
  // inside the orchestrator so a Google API failure can't break
  // availability.
  const [existing, externalBusy, calendarBlocks, groupBlocks, features] =
    await Promise.all([
      getBookingsInRange(staffUserId, viewerDay),
      getExternalBusyForUser(staffUserId, viewerDay.start, viewerDay.end),
      getCalendarEventsInRange(staffUserId, viewerDay),
      // Phase 17I-3B — when this staff is the HOST of a group session,
      // the slot is blocked for public booking. Future multi-host work
      // can union co-host ids the same way internal_meeting attendees
      // are handled in getCalendarEventsInRange.
      getGroupSessionsInRange(staffUserId, viewerDay),
      loadTenantFeatures(staff.tenantId),
    ]);
  const combinedBusy: Interval[] = [
    ...existing,
    ...externalBusy,
    ...calendarBlocks,
    ...groupBlocks,
  ];

  // Phase 16: tenant-level `bookingBuffers` gate. When OFF, the engine
  // ignores per-service before/after padding entirely — back-to-back
  // slots reappear even on services that have buffer minutes set.
  // This is a SAFE collapse to 0/0; service rows are not mutated and
  // re-enabling the toggle restores buffers on the next request (60s
  // cache TTL aside).
  const effectiveBufferBefore = features.bookingBuffers ? service.bufferBefore : 0;
  const effectiveBufferAfter  = features.bookingBuffers ? service.bufferAfter  : 0;

  // Walk every window independently and concatenate.
  const all: string[] = [];
  for (const window of bookable) {
    const slots = buildSlots({
      window,
      durationMinutes: service.durationMinutes,
      bufferBefore: effectiveBufferBefore,
      bufferAfter: effectiveBufferAfter,
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
 *   4. NEW (migration 0034): If no per-staff weekly rule exists,
 *      fall back to the tenant's default_workspace_hours for that
 *      day-of-week. This layer is fallback-only — it NEVER fires
 *      when a per-staff rule exists, so any staff who has ever
 *      configured custom hours sees byte-identical slot output to
 *      before this layer existed.
 *   5. Else → [].
 *
 * The booking engine does not know which layer produced the
 * returned windows — it only consumes resolved windows. That
 * separation is intentional: workspace inheritance + future
 * department defaults / seasonal schedules / etc. all extend this
 * function, never the engine.
 */
async function getStaffWorkingWindows(
  staffUserId: string,
  date: string,
  staffTimezone: string,
  tenantId: string
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

  const dayOfWeek = getDayOfWeekInTimezone(date, staffTimezone);

  // Rule 3: per-staff weekly rule.
  const rule = await db.query.availability.findFirst({
    where: and(
      eq(availability.userId, staffUserId),
      eq(availability.dayOfWeek, dayOfWeek)
    ),
  });
  if (rule) {
    return [
      {
        start: fromZonedTime(`${date}T${rule.startTime}`, staffTimezone),
        end: fromZonedTime(`${date}T${rule.endTime}`, staffTimezone),
      },
    ];
  }

  // Rule 4 (migration 0034): tenant default workspace hours fallback.
  // Only reached when per-staff rules don't exist — so any staff
  // configured before this layer shipped is unaffected.
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, tenantId),
    columns: { defaultWorkspaceHours: true },
  });
  const workspaceHours = readDefaultWorkspaceHours(tenant?.defaultWorkspaceHours);
  const defaultDay = getDefaultForDay(workspaceHours, dayOfWeek);
  if (defaultDay) {
    return [
      {
        start: fromZonedTime(`${date}T${defaultDay.start}`, staffTimezone),
        end: fromZonedTime(`${date}T${defaultDay.end}`, staffTimezone),
      },
    ];
  }

  // Rule 5: nothing configured anywhere.
  return [];
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

/**
 * Phase 17I-2D — fetch operational calendar_events that should block
 * the public booking flow from landing slots on top.
 *
 * Two membership predicates:
 *   • staff_user_id = the staff being checked (organizer of an internal
 *     meeting, or the blocked party on a blocked_time row)
 *   • attendee_user_ids @> [staffId] — internal meetings where this
 *     staff is an attendee. The jsonb @> operator checks containment;
 *     wrapping the id in a single-element jsonb array gives us
 *     "is this staff in the array" without scanning every value.
 *
 * No status column on calendar_events — every row is "live" until it
 * gets deleted. Time-window predicate mirrors bookings for symmetry
 * (end >= windowStart AND start < windowEnd).
 */
async function getCalendarEventsInRange(
  staffUserId: string,
  window: Interval
): Promise<Interval[]> {
  const rows = await db
    .select({
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
    })
    .from(calendarEvents)
    .where(
      and(
        or(
          eq(calendarEvents.staffUserId, staffUserId),
          sql`${calendarEvents.attendeeUserIds} @> ${JSON.stringify([staffUserId])}::jsonb`,
        ),
        gte(calendarEvents.endAt, window.start),
        lt(calendarEvents.startAt, window.end),
      ),
    );
  return rows.map((r) => ({ start: r.startAt, end: r.endAt }));
}

/**
 * Phase 17I-3B — fetch group_sessions where the staff is the HOST and
 * the session is still scheduled (not cancelled). Customers can't
 * book 1:1 appointments on top of a host's group session window.
 *
 * Cancelled sessions are filtered out at the SQL level so the public
 * booking flow re-opens the slot the moment the admin soft-cancels.
 *
 * Future multi-host extension will OR-union an additional jsonb
 * containment predicate the way getCalendarEventsInRange already
 * does for internal-meeting attendees.
 */
async function getGroupSessionsInRange(
  staffUserId: string,
  window: Interval
): Promise<Interval[]> {
  const rows = await db
    .select({
      startAt: groupSessions.startAt,
      endAt: groupSessions.endAt,
    })
    .from(groupSessions)
    .where(
      and(
        eq(groupSessions.hostUserId, staffUserId),
        eq(groupSessions.status, "scheduled"),
        gte(groupSessions.endAt, window.start),
        lt(groupSessions.startAt, window.end),
      ),
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
