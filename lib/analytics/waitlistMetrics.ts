/**
 * Waitlist metrics for one (tenant, day).
 *
 *   joins         — waitlists rows created today
 *   conversions   — waitlists rows transitioned to 'claimed' today
 *                   (via claimed_at timestamp)
 *   expiredHolds  — waitlist_notifications rows that hit 'expired' today
 *   avgWaitMinutes — average minutes between join and (claim OR expire)
 *                    for entries that closed today (null if none).
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { waitlistNotifications, waitlists } from "@/db/schema";

export type WaitlistDaily = {
  joins: number;
  conversions: number;
  expiredHolds: number;
  avgWaitMinutes: number | null;
};

export async function aggregateWaitlistMetrics(args: {
  tenantId: string;
  dayStart: Date;
  dayEnd: Date;
}): Promise<WaitlistDaily> {
  const [joins, claimedToday, expiredNotifs] = await Promise.all([
    db
      .select({ id: waitlists.id })
      .from(waitlists)
      .where(
        and(
          eq(waitlists.tenantId, args.tenantId),
          gte(waitlists.createdAt, args.dayStart),
          lt(waitlists.createdAt, args.dayEnd)
        )
      ),
    db
      .select({ createdAt: waitlists.createdAt, claimedAt: waitlists.claimedAt })
      .from(waitlists)
      .where(
        and(
          eq(waitlists.tenantId, args.tenantId),
          eq(waitlists.status, "claimed"),
          // claimed_at falls into the day
          gte(waitlists.claimedAt, args.dayStart),
          lt(waitlists.claimedAt, args.dayEnd)
        )
      ),
    db
      .select({ id: waitlistNotifications.id })
      .from(waitlistNotifications)
      .where(
        and(
          eq(waitlistNotifications.tenantId, args.tenantId),
          eq(waitlistNotifications.status, "expired"),
          gte(waitlistNotifications.respondedAt, args.dayStart),
          lt(waitlistNotifications.respondedAt, args.dayEnd)
        )
      ),
  ]);

  let avgWaitMinutes: number | null = null;
  if (claimedToday.length > 0) {
    let totalMs = 0;
    let count = 0;
    for (const r of claimedToday) {
      if (!r.claimedAt) continue;
      const diff = r.claimedAt.getTime() - r.createdAt.getTime();
      if (diff > 0) {
        totalMs += diff;
        count++;
      }
    }
    if (count > 0) avgWaitMinutes = Math.round(totalMs / count / 60_000);
  }

  return {
    joins: joins.length,
    conversions: claimedToday.length,
    expiredHolds: expiredNotifs.length,
    avgWaitMinutes,
  };
}

void sql;
