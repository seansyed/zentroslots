import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, customers } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/csv";

export async function GET() {
  try {
    const caller = await requireUser();

    // Snapshot per customer with their booking aggregates in a single
    // query, ordered alphabetically. Tags are serialized as a pipe-
    // delimited string in the CSV — Excel chokes on JSON arrays in cells.
    const rows = await db
      .select({
        id: customers.id,
        name: customers.name,
        email: customers.email,
        phone: customers.phone,
        status: customers.status,
        tags: customers.tags,
        createdAt: customers.createdAt,
        bookingsTotal: sql<number>`(SELECT COUNT(*)::int FROM bookings b WHERE b.customer_id = ${customers.id})`,
        bookingsCompleted: sql<number>`(SELECT COUNT(*)::int FROM bookings b WHERE b.customer_id = ${customers.id} AND b.status = 'completed')`,
        bookingsCancelled: sql<number>`(SELECT COUNT(*)::int FROM bookings b WHERE b.customer_id = ${customers.id} AND b.status = 'cancelled')`,
        bookingsNoShow: sql<number>`(SELECT COUNT(*)::int FROM bookings b WHERE b.customer_id = ${customers.id} AND b.status = 'no_show')`,
        lastBookingAt: sql<Date | null>`(SELECT MAX(b.start_at) FROM ${bookings} b WHERE b.customer_id = ${customers.id})`,
      })
      .from(customers)
      .where(eq(customers.tenantId, caller.tenantId))
      .orderBy(asc(customers.name))
      .limit(10000);

    const flat = rows.map((r) => ({
      ...r,
      tags: Array.isArray(r.tags) ? (r.tags as string[]).join(" | ") : "",
      lastBookingAt: r.lastBookingAt ? new Date(r.lastBookingAt as unknown as string) : null,
    }));

    const csv = toCsv(flat, [
      { key: "id", header: "customer_id" },
      { key: "name", header: "name" },
      { key: "email", header: "email" },
      { key: "phone", header: "phone" },
      { key: "status", header: "status" },
      { key: "tags", header: "tags" },
      { key: "bookingsTotal", header: "bookings_total" },
      { key: "bookingsCompleted", header: "bookings_completed" },
      { key: "bookingsCancelled", header: "bookings_cancelled" },
      { key: "bookingsNoShow", header: "bookings_no_show" },
      { key: "lastBookingAt", header: "last_booking_at" },
      { key: "createdAt", header: "created_at" },
    ]);
    return csvResponse(`customers-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  } catch (err) {
    return errorResponse(err);
  }
}
