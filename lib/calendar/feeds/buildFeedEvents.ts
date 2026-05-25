/**
 * Phase ICAL-2 — assemble the FeedEvent[] for a given staff user
 * from the operational sources.
 *
 * Window (bounded for performance):
 *   • +180 days forward — long enough that staff see their full
 *     planning horizon, short enough that the feed stays small
 *     (Apple polls roughly hourly; bloated feeds = slow syncs +
 *     wasted bandwidth).
 *   • -30 days backward — long enough for "what did I do last
 *     month?" recall, short enough that the feed doesn't grow
 *     unbounded over years.
 *
 * Sources:
 *   1. bookings — customer appointments where staff is host
 *   2. calendar_events — blocked_time + internal_meeting (Phase
 *      17I-2A) where staff is the owner OR an attendee
 *   3. group_sessions — multi-attendee sessions where staff is host
 *      (Phase 17I-3A)
 *
 * Cancellation handling:
 *   • Cancelled bookings (status in: cancelled, no_show, refunded)
 *     are EXCLUDED entirely. Apple Calendar treats the absence as
 *     a removal on next poll. Simpler than emitting STATUS:CANCELLED
 *     in a PUBLISH feed (PUBLISH method semantics around cancelled
 *     events are ambiguous across clients).
 *
 * Tenant isolation:
 *   • Every query carries (tenantId, staffUserId). Cross-tenant
 *     access cannot happen even if the token verification logic is
 *     bypassed (defense in depth).
 *
 * Pure SQL — no joins for embellishment (service name, host name,
 * etc.). We do a single per-source query + a small in-process join.
 */

import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  calendarEvents,
  groupSessions,
  services,
  tenants,
  users,
} from "@/db/schema";
import { bookingSequence, bookingUid } from "@/lib/calendar/ics/booking-ics";
import type { FeedEvent } from "./types";

/** Window defaults — overridable for tests. */
export const FEED_WINDOW_DAYS_BACK = 30;
export const FEED_WINDOW_DAYS_FORWARD = 180;

/** Booking statuses that ARE rendered in the feed. Anything else
 *  (cancelled/no_show/refunded/payment_failed) is omitted entirely.
 *  Typed as the discriminated union the bookings.status column
 *  expects so drizzle's inArray() accepts it without a cast. */
type FeedVisibleStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "pending_payment";

const FEED_VISIBLE_STATUSES: FeedVisibleStatus[] = [
  "pending",
  "confirmed",
  "completed",
  "pending_payment",
];

type LoadOpts = {
  /** Override window for tests. Defaults to now-30d to now+180d. */
  now?: Date;
  daysBack?: number;
  daysForward?: number;
};

/** Assemble the full FeedEvent[] for a staff member. Returns events
 *  sorted by startAt ascending. */
export async function buildStaffFeedEvents(
  args: { tenantId: string; staffUserId: string },
  opts: LoadOpts = {},
): Promise<{
  events: FeedEvent[];
  staffTimezone: string;
  tenantName: string;
  staffName: string;
}> {
  const now = opts.now ?? new Date();
  const daysBack = opts.daysBack ?? FEED_WINDOW_DAYS_BACK;
  const daysForward = opts.daysForward ?? FEED_WINDOW_DAYS_FORWARD;

  const windowStart = new Date(now.getTime() - daysBack * 86_400_000);
  const windowEnd = new Date(now.getTime() + daysForward * 86_400_000);

  // ─── Staff identity ─────────────────────────────────────────────
  // One round trip to resolve the timezone (used for every event's
  // TZID) + the display name (used in summary fallbacks).
  const [staff] = await db
    .select({
      id: users.id,
      name: users.name,
      tenantId: users.tenantId,
      timezone: users.timezone,
    })
    .from(users)
    .where(
      and(
        eq(users.id, args.staffUserId),
        eq(users.tenantId, args.tenantId),
      ),
    )
    .limit(1);

  // Defensive fallback — token verification already proved the user
  // exists, but the row could have been deleted between verify and
  // load. Empty feed beats a 500.
  if (!staff) {
    return {
      events: [],
      staffTimezone: "UTC",
      tenantName: "ZentroMeet",
      staffName: "",
    };
  }

  const [tenant] = await db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, args.tenantId))
    .limit(1);

  const tenantName = tenant?.name ?? "ZentroMeet";
  const staffTimezone = staff.timezone || "UTC";

  // ─── Bookings ───────────────────────────────────────────────────
  // Window: any booking that OVERLAPS [windowStart, windowEnd]. Strict
  // start-in-window would drop events that started before but extend
  // into the window — rare but legal.
  const bookingRows = await db
    .select({
      id: bookings.id,
      startAt: bookings.startAt,
      endAt: bookings.endAt,
      status: bookings.status,
      clientName: bookings.clientName,
      notes: bookings.notes,
      meetLink: bookings.meetLink,
      updatedAt: bookings.updatedAt,
      serviceId: bookings.serviceId,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        eq(bookings.staffUserId, args.staffUserId),
        inArray(bookings.status, FEED_VISIBLE_STATUSES),
        lte(bookings.startAt, windowEnd),
        gte(bookings.endAt, windowStart),
      ),
    );

  // Service name lookup — one query for all referenced services, not
  // a join (lets us reuse the bookings query above and keeps the row
  // shape stable for testing).
  const serviceIds = Array.from(
    new Set(bookingRows.map((b) => b.serviceId).filter(Boolean)),
  );
  const serviceMap = new Map<string, string>();
  if (serviceIds.length > 0) {
    const svc = await db
      .select({ id: services.id, name: services.name })
      .from(services)
      .where(inArray(services.id, serviceIds));
    for (const s of svc) serviceMap.set(s.id, s.name);
  }

  const bookingEvents: FeedEvent[] = bookingRows.map((b) => {
    const serviceName = serviceMap.get(b.serviceId) ?? "Appointment";
    const summary = b.clientName
      ? `${serviceName} — ${b.clientName}`
      : serviceName;
    const descLines: string[] = [];
    if (b.clientName) descLines.push(`Client: ${b.clientName}`);
    if (b.meetLink) descLines.push(`Join: ${b.meetLink}`);
    if (b.notes) descLines.push("", b.notes);
    return {
      uid: bookingUid(b.id),
      sequence: bookingSequence(b.updatedAt),
      startAt: b.startAt,
      endAt: b.endAt,
      timezone: staffTimezone,
      summary,
      description: descLines.length ? descLines.join("\n") : undefined,
      location: b.meetLink ?? undefined,
      lastModified: b.updatedAt,
    };
  });

  // ─── Calendar events (blocked time + internal meeting) ──────────
  // Staff is either the owner (staff_user_id) or a listed attendee.
  // The attendee check uses jsonb containment.
  const calendarEventRows = await db
    .select({
      id: calendarEvents.id,
      eventType: calendarEvents.eventType,
      title: calendarEvents.title,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      notes: calendarEvents.notes,
      location: calendarEvents.location,
      meetLink: calendarEvents.meetLink,
      updatedAt: calendarEvents.updatedAt,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.tenantId, args.tenantId),
        or(
          eq(calendarEvents.staffUserId, args.staffUserId),
          // jsonb containment: attendee_user_ids @> '["<id>"]'::jsonb
          sql`${calendarEvents.attendeeUserIds} @> ${JSON.stringify([
            args.staffUserId,
          ])}::jsonb`,
        ),
        lte(calendarEvents.startAt, windowEnd),
        gte(calendarEvents.endAt, windowStart),
      ),
    );

  const calendarEventFeeds: FeedEvent[] = calendarEventRows.map((c) => {
    const descLines: string[] = [];
    if (c.eventType === "blocked_time") descLines.push("Blocked time");
    if (c.eventType === "internal_meeting") descLines.push("Internal meeting");
    if (c.meetLink) descLines.push(`Join: ${c.meetLink}`);
    if (c.notes) descLines.push("", c.notes);
    return {
      uid: `calevt-${c.id}@zentromeet`,
      sequence: Math.floor(c.updatedAt.getTime() / 1000) % 0x7fffffff,
      startAt: c.startAt,
      endAt: c.endAt,
      timezone: staffTimezone,
      summary: c.title,
      description: descLines.length ? descLines.join("\n") : undefined,
      location: c.location ?? c.meetLink ?? undefined,
      lastModified: c.updatedAt,
    };
  });

  // ─── Group sessions (host = this staff) ─────────────────────────
  const groupSessionRows = await db
    .select({
      id: groupSessions.id,
      title: groupSessions.title,
      startAt: groupSessions.startAt,
      endAt: groupSessions.endAt,
      status: groupSessions.status,
      meetLink: groupSessions.meetLink,
      location: groupSessions.location,
      notes: groupSessions.notes,
      maxCapacity: groupSessions.maxCapacity,
      currentRegistrations: groupSessions.currentRegistrations,
      updatedAt: groupSessions.updatedAt,
    })
    .from(groupSessions)
    .where(
      and(
        eq(groupSessions.tenantId, args.tenantId),
        eq(groupSessions.hostUserId, args.staffUserId),
        // 'scheduled' is the only visible status; others (cancelled
        // etc.) are filtered out like booking statuses.
        eq(groupSessions.status, "scheduled"),
        lte(groupSessions.startAt, windowEnd),
        gte(groupSessions.endAt, windowStart),
      ),
    );

  const groupSessionFeeds: FeedEvent[] = groupSessionRows.map((g) => {
    const descLines: string[] = [
      `Group session — ${g.currentRegistrations}/${g.maxCapacity || "∞"} registered`,
    ];
    if (g.meetLink) descLines.push(`Join: ${g.meetLink}`);
    if (g.notes) descLines.push("", g.notes);
    return {
      uid: `grpsess-${g.id}@zentromeet`,
      sequence: Math.floor(g.updatedAt.getTime() / 1000) % 0x7fffffff,
      startAt: g.startAt,
      endAt: g.endAt,
      timezone: staffTimezone,
      summary: g.title,
      description: descLines.join("\n"),
      location: g.location ?? g.meetLink ?? undefined,
      lastModified: g.updatedAt,
    };
  });

  // ─── Merge + sort ───────────────────────────────────────────────
  const all: FeedEvent[] = [
    ...bookingEvents,
    ...calendarEventFeeds,
    ...groupSessionFeeds,
  ];
  all.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  return {
    events: all,
    staffTimezone,
    tenantName,
    staffName: staff.name,
  };
}
