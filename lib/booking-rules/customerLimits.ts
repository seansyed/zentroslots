/**
 * Customer-scoped checks:
 *   - daily cap (count of confirmed bookings by this email on the same
 *     day, in tenant TZ)
 *   - cooldown window (time since this email's nearest other
 *     confirmed booking; if it's less than the cooldown, reject)
 *
 * Email comparison is case-insensitive — same convention as the
 * customers table.
 */
import { and, asc, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";

/**
 * Count of CONFIRMED bookings by this email that fall on the same
 * tenant-local date as the candidate booking. Excludes the candidate
 * itself (it hasn't been inserted yet).
 */
export async function countCustomerBookingsOnDay(args: {
  tenantId: string;
  clientEmail: string;
  /** Day window in UTC corresponding to the customer's local day. */
  dayStartUtc: Date;
  dayEndUtc: Date;
}): Promise<number> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        eq(bookings.status, "confirmed"),
        sql`lower(${bookings.clientEmail}) = lower(${args.clientEmail})`,
        gte(bookings.startAt, args.dayStartUtc),
        lt(bookings.startAt, args.dayEndUtc)
      )
    );
  return rows.length;
}

/**
 * Returns the smallest gap (in minutes) between the candidate's
 * (startAt, endAt) and any of this customer's existing confirmed
 * bookings in the tenant. null if no other bookings exist.
 *
 * Gap is computed as: min(
 *   abs(candidate.start - other.end),
 *   abs(other.start - candidate.end)
 * )
 *
 * — i.e. how close the two bookings are at the closest edge. 0 means
 * they're adjacent, negative would mean overlap (but overlap is
 * already handled by the staff EXCLUDE constraint at insert).
 */
export async function smallestGapToCustomerBooking(args: {
  tenantId: string;
  clientEmail: string;
  startAt: Date;
  endAt: Date;
  /** Only consider other bookings within this many minutes — saves a
   *  full scan. The caller passes (cooldownMinutes * 2) typically. */
  searchWindowMinutes: number;
}): Promise<number | null> {
  const windowStart = new Date(args.startAt.getTime() - args.searchWindowMinutes * 60_000);
  const windowEnd = new Date(args.endAt.getTime() + args.searchWindowMinutes * 60_000);

  const rows = await db
    .select({
      startAt: bookings.startAt,
      endAt: bookings.endAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        eq(bookings.status, "confirmed"),
        sql`lower(${bookings.clientEmail}) = lower(${args.clientEmail})`,
        gte(bookings.startAt, windowStart),
        lt(bookings.startAt, windowEnd)
      )
    )
    .orderBy(asc(bookings.startAt));

  let smallest: number | null = null;
  for (const r of rows) {
    const gapAfter = (args.startAt.getTime() - r.endAt.getTime()) / 60_000;
    const gapBefore = (r.startAt.getTime() - args.endAt.getTime()) / 60_000;
    const gap = Math.min(Math.abs(gapAfter), Math.abs(gapBefore));
    if (smallest === null || gap < smallest) smallest = gap;
  }
  return smallest;
}
