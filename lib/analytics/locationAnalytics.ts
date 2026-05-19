/**
 * Per-location and per-department roll-ups (DB-touching).
 *
 * Tenant-isolated; never throws (returns empty rows on failure or
 * absence). Reads bookings + billing_transactions filtered by
 * locationId / departmentId.
 *
 * Tenants without locations or departments configured see empty rows
 * — the dashboard hides the section gracefully.
 */
import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import {
  billingTransactions,
  bookings,
  departments,
  locations,
} from "@/db/schema";

export type LocationRollup = {
  locationId: string;
  locationName: string;
  bookings: number;
  completed: number;
  cancelled: number;
  grossRevenueCents: number;
};

export type DepartmentRollup = {
  departmentId: string;
  departmentName: string;
  bookings: number;
  completed: number;
  cancelled: number;
  grossRevenueCents: number;
};

export async function aggregateLocationAnalytics(args: {
  tenantId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<LocationRollup[]> {
  try {
    // Tenant-scoped per-location aggregation. Join bookings → locations
    // and aggregate.
    const rows = await db
      .select({
        locationId: locations.id,
        locationName: locations.name,
        n: sql<number>`count(${bookings.id})::int`,
        completed: sql<number>`sum(case when ${bookings.status} = 'completed' then 1 else 0 end)::int`,
        cancelled: sql<number>`sum(case when ${bookings.status} = 'cancelled' then 1 else 0 end)::int`,
      })
      .from(bookings)
      .innerJoin(locations, eq(locations.id, bookings.locationId))
      .where(
        and(
          eq(bookings.tenantId, args.tenantId),
          isNotNull(bookings.locationId),
          gte(bookings.startAt, args.windowStart),
          lt(bookings.startAt, args.windowEnd)
        )
      )
      .groupBy(locations.id, locations.name)
      .orderBy(desc(sql`count(${bookings.id})`));

    // Per-location revenue from billing_transactions joined back to
    // bookings → locations. Second read, in parallel-ish.
    const revRows = await db
      .select({
        locationId: locations.id,
        revenueCents: sql<number>`coalesce(sum(${billingTransactions.amountCents}), 0)::int`,
      })
      .from(billingTransactions)
      .innerJoin(bookings, eq(bookings.id, billingTransactions.bookingId))
      .innerJoin(locations, eq(locations.id, bookings.locationId))
      .where(
        and(
          eq(billingTransactions.tenantId, args.tenantId),
          eq(billingTransactions.status, "paid"),
          gte(billingTransactions.paidAt, args.windowStart),
          lt(billingTransactions.paidAt, args.windowEnd)
        )
      )
      .groupBy(locations.id);
    const revByLoc = new Map(revRows.map((r) => [r.locationId, r.revenueCents]));

    return rows.map((r) => ({
      locationId: r.locationId,
      locationName: r.locationName,
      bookings: Number(r.n),
      completed: Number(r.completed ?? 0),
      cancelled: Number(r.cancelled ?? 0),
      grossRevenueCents: revByLoc.get(r.locationId) ?? 0,
    }));
  } catch (e) {
    console.error("[analytics] locationAnalytics failed:", e);
    return [];
  }
}

export async function aggregateDepartmentAnalytics(args: {
  tenantId: string;
  windowStart: Date;
  windowEnd: Date;
}): Promise<DepartmentRollup[]> {
  try {
    const rows = await db
      .select({
        departmentId: departments.id,
        departmentName: departments.name,
        n: sql<number>`count(${bookings.id})::int`,
        completed: sql<number>`sum(case when ${bookings.status} = 'completed' then 1 else 0 end)::int`,
        cancelled: sql<number>`sum(case when ${bookings.status} = 'cancelled' then 1 else 0 end)::int`,
      })
      .from(bookings)
      .innerJoin(departments, eq(departments.id, bookings.departmentId))
      .where(
        and(
          eq(bookings.tenantId, args.tenantId),
          isNotNull(bookings.departmentId),
          gte(bookings.startAt, args.windowStart),
          lt(bookings.startAt, args.windowEnd)
        )
      )
      .groupBy(departments.id, departments.name)
      .orderBy(desc(sql`count(${bookings.id})`));

    const revRows = await db
      .select({
        departmentId: departments.id,
        revenueCents: sql<number>`coalesce(sum(${billingTransactions.amountCents}), 0)::int`,
      })
      .from(billingTransactions)
      .innerJoin(bookings, eq(bookings.id, billingTransactions.bookingId))
      .innerJoin(departments, eq(departments.id, bookings.departmentId))
      .where(
        and(
          eq(billingTransactions.tenantId, args.tenantId),
          eq(billingTransactions.status, "paid"),
          gte(billingTransactions.paidAt, args.windowStart),
          lt(billingTransactions.paidAt, args.windowEnd)
        )
      )
      .groupBy(departments.id);
    const revByDept = new Map(revRows.map((r) => [r.departmentId, r.revenueCents]));

    return rows.map((r) => ({
      departmentId: r.departmentId,
      departmentName: r.departmentName,
      bookings: Number(r.n),
      completed: Number(r.completed ?? 0),
      cancelled: Number(r.cancelled ?? 0),
      grossRevenueCents: revByDept.get(r.departmentId) ?? 0,
    }));
  } catch (e) {
    console.error("[analytics] departmentAnalytics failed:", e);
    return [];
  }
}
