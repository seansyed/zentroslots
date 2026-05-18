/**
 * Eligibility filter for staff routing.
 *
 * Inputs: tenantId, serviceId, the requested window (startAt..endAt),
 * and an optional candidate set (priority/weighted modes can restrict
 * the pool to specifically-listed users).
 *
 * Outputs: an array of staff ids who:
 *   1. Belong to the tenant
 *   2. Deliver this service (via service_staff)
 *   3. Are working during the requested window (availability +
 *      overrides), checked in the staff's own timezone
 *   4. Have no internal booking that collides with the window
 *   5. Have no external Google Calendar busy interval colliding with
 *      the window (when an active calendar connection exists)
 *
 * Reuses the same primitives as lib/availability.ts so the routing
 * engine and slot generator agree on what "available" means.
 *
 * Critical: NEVER returns staff who would cause the EXCLUDE constraint
 * to throw. The constraint is the final backstop, but the engine MUST
 * pick a staff member who'll succeed at insert time.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  availability,
  availabilityOverrides,
  bookings,
  serviceStaff,
  users,
} from "@/db/schema";
import { getExternalBusyForUser } from "@/lib/calendar/sync";

type Interval = { start: Date; end: Date };

export type EligibilityInput = {
  tenantId: string;
  serviceId: string;
  startAt: Date;
  endAt: Date;
  /** Optional pool restriction. priority/weighted modes pass the
   *  configured pool here; round_robin/least_busy don't restrict. */
  restrictTo?: string[];
};

/**
 * Returns staff ids eligible to take the slot. Order is stable
 * alphabetic by user id — callers that care about order (round-robin,
 * least-busy) sort by their own metric afterward.
 */
export async function getEligibleStaff(input: EligibilityInput): Promise<string[]> {
  // Step 1: load the service's full eligible pool (service_staff).
  const poolRows = await db
    .select({ userId: serviceStaff.userId })
    .from(serviceStaff)
    .where(
      and(
        eq(serviceStaff.tenantId, input.tenantId),
        eq(serviceStaff.serviceId, input.serviceId)
      )
    );
  let candidates = poolRows.map((r) => r.userId);
  if (candidates.length === 0) return [];

  // Step 2: restrict to the rule's pool (priority/weighted modes).
  if (input.restrictTo && input.restrictTo.length > 0) {
    const allowed = new Set(input.restrictTo);
    candidates = candidates.filter((id) => allowed.has(id));
    if (candidates.length === 0) return [];
  }

  // Step 3: bulk fetch staff rows for timezone resolution.
  const userRows = await db
    .select({ id: users.id, timezone: users.timezone })
    .from(users)
    .where(
      and(
        eq(users.tenantId, input.tenantId),
        sql`${users.id} = ANY(${candidates})`
      )
    );
  const tzByUser = new Map(userRows.map((u) => [u.id, u.timezone]));

  // Step 4: filter to staff working during the window. Done per-user
  // because each user has their own timezone.
  const working: string[] = [];
  for (const userId of candidates) {
    const tz = tzByUser.get(userId) ?? "UTC";
    if (await isStaffWorking(userId, input.startAt, input.endAt, tz)) {
      working.push(userId);
    }
  }
  if (working.length === 0) return [];

  // Step 5: filter out staff with conflicting internal bookings. One
  // query covers all candidates.
  const conflictRows = await db
    .select({ staffUserId: bookings.staffUserId })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, input.tenantId),
        eq(bookings.status, "confirmed"),
        sql`${bookings.staffUserId} = ANY(${working})`,
        // Overlap: existing.endAt > requested.start AND existing.startAt < requested.end
        gte(bookings.endAt, input.startAt),
        lt(bookings.startAt, input.endAt)
      )
    );
  const internallyBusy = new Set(conflictRows.map((r) => r.staffUserId));
  let free = working.filter((id) => !internallyBusy.has(id));
  if (free.length === 0) return [];

  // Step 6: external Google busy. Done per-staff because each user
  // has their own connection. getExternalBusyForUser returns [] for
  // staff without an active connection — no-op in that case (additive
  // guarantee preserved for tenants without calendar sync).
  const externalChecks = await Promise.all(
    free.map(async (userId) => {
      const busy = await getExternalBusyForUser(userId, input.startAt, input.endAt);
      const collides = busy.some((b) => intervalsOverlap(b, { start: input.startAt, end: input.endAt }));
      return collides ? null : userId;
    })
  );
  free = externalChecks.filter((id): id is string => id !== null);

  return free;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Is the staff scheduled to be working for the entire requested window
 * (start..end) in their own timezone? Respects the same override
 * resolution as lib/availability.ts:
 *   1. Full-day unavailable override → false
 *   2. Override windows present → must contain the requested window
 *   3. Weekly availability rule → must contain the requested window
 */
async function isStaffWorking(
  userId: string,
  startAt: Date,
  endAt: Date,
  staffTimezone: string
): Promise<boolean> {
  // Resolve the staff-local date of the window's START. (Bookings
  // don't span days — the existing engine guards against that — so
  // checking the start date is sufficient.)
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone: staffTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(startAt);

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
        eq(availabilityOverrides.date, dateStr)
      )
    );

  // Rule 1: any full-day block.
  if (overrides.some((o) => o.unavailable)) return false;

  const windows = await resolveWorkingWindows(userId, dateStr, staffTimezone, overrides);
  // Window must fully contain the requested booking window.
  return windows.some((w) => w.start <= startAt && w.end >= endAt);
}

async function resolveWorkingWindows(
  userId: string,
  dateStr: string,
  staffTimezone: string,
  overrides: { unavailable: boolean; startTime: string | null; endTime: string | null }[]
): Promise<Interval[]> {
  // Rule 2: override windows replace weekly.
  if (overrides.length > 0) {
    const out: Interval[] = [];
    for (const o of overrides) {
      if (!o.startTime || !o.endTime) continue;
      out.push({
        start: zoned(`${dateStr}T${o.startTime}`, staffTimezone),
        end: zoned(`${dateStr}T${o.endTime}`, staffTimezone),
      });
    }
    return out;
  }
  // Rule 3: weekly rule.
  const dayOfWeek = dayOfWeekInTz(dateStr, staffTimezone);
  const rule = await db.query.availability.findFirst({
    where: and(eq(availability.userId, userId), eq(availability.dayOfWeek, dayOfWeek)),
  });
  if (!rule) return [];
  return [
    {
      start: zoned(`${dateStr}T${rule.startTime}`, staffTimezone),
      end: zoned(`${dateStr}T${rule.endTime}`, staffTimezone),
    },
  ];
}

function dayOfWeekInTz(date: string, timezone: string): number {
  const anchor = zoned(`${date}T12:00:00`, timezone);
  const wd = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone }).format(anchor);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd];
}

function zoned(local: string, timezone: string): Date {
  // Lightweight inline equivalent of fromZonedTime to avoid pulling in
  // the dep at the routing-lib layer. Uses Intl with the timezone to
  // figure out the UTC offset.
  // Approach: build a Date assuming UTC, then walk the offset.
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
