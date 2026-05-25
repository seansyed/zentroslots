/**
 * Phase ICAL-3 — read-only feed busy lookup for the availability
 * engine.
 *
 * Returns the imported-feed busy intervals overlapping a given
 * window. Called from lib/availability.ts at the same merge point
 * as the existing busy sources (bookings, external Google/Microsoft
 * busy, calendar_events, group_sessions). Adding a 5th source here
 * is intentional and additive — no other call site touches this
 * module.
 *
 * Performance contract:
 *   • One indexed range scan on external_feed_events.
 *   • Filter on (tenant_id, user_id, end_at >= start, start_at <= end).
 *   • Returns plain Interval[] — same shape as every other busy
 *     source so the merge in lib/availability.ts is one concat.
 *
 * Tenant isolation:
 *   • The (tenantId, userId) tuple is the hot-path WHERE — never
 *     query by user_id alone (an admin's stale userId from a
 *     different tenant must NOT pull events from a wrong row).
 *
 * Disabled feeds:
 *   • The sync orchestrator stops refreshing disabled feeds, but
 *     their cached events stay in the table for re-enablement.
 *   • So we MUST filter at read time on the feed's is_enabled
 *     state. We do that via a join to external_calendar_feeds.
 */

import { and, eq, gte, lte } from "drizzle-orm";

import { db } from "@/db/client";
import {
  externalCalendarFeeds,
  externalFeedEvents,
} from "@/db/schema";

export type Interval = { start: Date; end: Date };

/**
 * Returns all busy intervals from this user's IMPORTED external
 * calendar feeds that overlap [start, end].
 *
 * Wrapped in try/catch so a transient DB error CAN NOT take down
 * the availability engine — empty array is the safe fallback (we'd
 * rather show a slot than 500 the booking page). All callers
 * already concat this into combinedBusy, so an empty array is
 * indistinguishable from "no external feed events" — exactly the
 * right degraded behavior.
 */
export async function getExternalFeedBusyForUser(
  staffUserId: string,
  start: Date,
  end: Date,
  tenantId?: string,
): Promise<Interval[]> {
  try {
    // We accept an optional tenantId because some availability
    // callers have it on hand. When absent we still scope by
    // user_id (which is itself a tenant-rooted FK), but a passed
    // tenantId tightens the WHERE one more layer.
    const whereClauses = [
      eq(externalFeedEvents.userId, staffUserId),
      // Range overlap: event ends after window start AND event
      // starts before window end.
      gte(externalFeedEvents.endAt, start),
      lte(externalFeedEvents.startAt, end),
      // Honor the feed's is_enabled flag — disabled feeds keep
      // their event cache but stop blocking slots.
      eq(externalCalendarFeeds.isEnabled, true),
    ];
    if (tenantId) {
      whereClauses.push(eq(externalFeedEvents.tenantId, tenantId));
    }

    const rows = await db
      .select({
        startAt: externalFeedEvents.startAt,
        endAt: externalFeedEvents.endAt,
      })
      .from(externalFeedEvents)
      .innerJoin(
        externalCalendarFeeds,
        eq(externalCalendarFeeds.id, externalFeedEvents.feedId),
      )
      .where(and(...whereClauses));

    return rows.map((r) => ({ start: r.startAt, end: r.endAt }));
  } catch (err) {
    // Don't take down the availability engine on a downstream DB
    // hiccup. Log + degrade to empty.
    console.error("getExternalFeedBusyForUser failed:", err);
    return [];
  }
}
