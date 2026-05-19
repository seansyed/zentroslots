/**
 * Customer-intelligence aggregator (DB-touching, tenant-isolated).
 *
 * Returns:
 *   - repeatCustomerRate: % of bookings in window from customers who
 *     had at least one prior booking with this tenant before window start
 *   - retentionRate: % of customers who booked at least twice during
 *     a 60-day window
 *   - newCustomersThisPeriod: distinct emails with first-ever booking
 *     in this window
 *
 * Email-keyed (case-insensitive). Never throws.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";

export type CustomerIntelligence = {
  repeatCustomerRate: number; // 0..100 integer %
  retentionRate: number;
  newCustomersThisPeriod: number;
  bookingsByExistingCustomers: number;
  bookingsByNewCustomers: number;
};

export function emptyCustomerIntelligence(): CustomerIntelligence {
  return {
    repeatCustomerRate: 0,
    retentionRate: 0,
    newCustomersThisPeriod: 0,
    bookingsByExistingCustomers: 0,
    bookingsByNewCustomers: 0,
  };
}

export async function aggregateCustomerIntelligence(args: {
  tenantId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<CustomerIntelligence> {
  try {
    // Customers who booked in the window.
    const windowRows = await db
      .select({
        email: sql<string>`lower(${bookings.clientEmail})`,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, args.tenantId),
          sql`${bookings.status} <> 'cancelled'`,
          gte(bookings.startAt, args.windowStart),
          lt(bookings.startAt, args.windowEnd)
        )
      );

    if (windowRows.length === 0) return emptyCustomerIntelligence();

    const emails = Array.from(new Set(windowRows.map((r) => r.email).filter(Boolean)));
    if (emails.length === 0) return emptyCustomerIntelligence();

    // For each in-window email: did they have a booking BEFORE windowStart?
    const priorRows = await db
      .select({
        email: sql<string>`lower(${bookings.clientEmail})`,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, args.tenantId),
          sql`${bookings.status} <> 'cancelled'`,
          lt(bookings.startAt, args.windowStart),
          sql`lower(${bookings.clientEmail}) = ANY(${emails})`
        )
      );
    const priorEmails = new Set(priorRows.map((r) => r.email));

    let bookingsByExisting = 0;
    let bookingsByNew = 0;
    for (const r of windowRows) {
      if (priorEmails.has(r.email)) bookingsByExisting++;
      else bookingsByNew++;
    }
    const newCustomers = emails.filter((e) => !priorEmails.has(e)).length;
    const repeatRate =
      windowRows.length > 0 ? Math.round((bookingsByExisting / windowRows.length) * 100) : 0;

    // Retention: customers who booked ≥ 2 times in this same window.
    const emailCounts = new Map<string, number>();
    for (const r of windowRows) {
      emailCounts.set(r.email, (emailCounts.get(r.email) ?? 0) + 1);
    }
    const repeats = Array.from(emailCounts.values()).filter((c) => c >= 2).length;
    const retentionRate = emails.length > 0 ? Math.round((repeats / emails.length) * 100) : 0;

    return {
      repeatCustomerRate: repeatRate,
      retentionRate,
      newCustomersThisPeriod: newCustomers,
      bookingsByExistingCustomers: bookingsByExisting,
      bookingsByNewCustomers: bookingsByNew,
    };
  } catch (e) {
    console.error("[analytics] customerIntelligence failed:", e);
    return emptyCustomerIntelligence();
  }
}

/** Helper used by scheduledReports composer to drive executive metrics
 *  repeat-customer comparison. Returns the count-shape buildExecutive
 *  Summary expects. */
export async function loadRepeatCustomerForComparison(args: {
  tenantId: string;
  currentStart: Date;
  currentEnd: Date;
  prevStart: Date;
  prevEnd: Date;
}): Promise<{
  currentRepeat: number;
  currentTotal: number;
  prevRepeat: number;
  prevTotal: number;
}> {
  try {
    const [cur, prev] = await Promise.all([
      aggregateCustomerIntelligence({
        tenantId: args.tenantId,
        windowStart: args.currentStart,
        windowEnd: args.currentEnd,
      }),
      aggregateCustomerIntelligence({
        tenantId: args.tenantId,
        windowStart: args.prevStart,
        windowEnd: args.prevEnd,
      }),
    ]);
    return {
      currentRepeat: cur.bookingsByExistingCustomers,
      currentTotal: cur.bookingsByExistingCustomers + cur.bookingsByNewCustomers,
      prevRepeat: prev.bookingsByExistingCustomers,
      prevTotal: prev.bookingsByExistingCustomers + prev.bookingsByNewCustomers,
    };
  } catch {
    return { currentRepeat: 0, currentTotal: 0, prevRepeat: 0, prevTotal: 0 };
  }
}
