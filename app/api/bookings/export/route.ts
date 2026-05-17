import { NextRequest } from "next/server";
import { and, desc, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, customers, services, users } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/csv";

export async function GET(req: NextRequest) {
  try {
    const caller = await requireUser();
    const sp = req.nextUrl.searchParams;
    const status = sp.get("status");
    const startFrom = sp.get("from");
    const startTo = sp.get("to");

    const conds = [eq(bookings.tenantId, caller.tenantId)];
    // Staff are scoped to their own bookings — admin sees the whole tenant.
    if (caller.role !== "admin") conds.push(eq(bookings.staffUserId, caller.id));

    if (status && ["pending", "confirmed", "cancelled", "completed", "no_show"].includes(status)) {
      conds.push(eq(bookings.status, status as "pending" | "confirmed" | "cancelled" | "completed" | "no_show"));
    }
    if (startFrom) {
      const d = new Date(startFrom);
      if (!Number.isNaN(d.getTime())) conds.push(gte(bookings.startAt, d));
    }
    if (startTo) {
      const d = new Date(startTo);
      if (!Number.isNaN(d.getTime())) conds.push(lt(bookings.startAt, d));
    }

    const rows = await db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        status: bookings.status,
        clientName: bookings.clientName,
        clientEmail: bookings.clientEmail,
        serviceName: services.name,
        staffName: users.name,
        customerName: customers.name,
        priceCents: services.price,
        meetLink: bookings.meetLink,
        notes: bookings.notes,
        createdAt: bookings.createdAt,
      })
      .from(bookings)
      .innerJoin(services, eq(services.id, bookings.serviceId))
      .innerJoin(users, eq(users.id, bookings.staffUserId))
      .leftJoin(customers, eq(customers.id, bookings.customerId))
      .where(and(...conds))
      .orderBy(desc(bookings.startAt))
      .limit(5000); // hard cap; if a tenant ever exceeds this, paginate.

    const csv = toCsv(rows, [
      { key: "id", header: "booking_id" },
      { key: "startAt", header: "start_at" },
      { key: "endAt", header: "end_at" },
      { key: "status", header: "status" },
      { key: "serviceName", header: "service" },
      { key: "staffName", header: "staff" },
      { key: "clientName", header: "client_name" },
      { key: "clientEmail", header: "client_email" },
      { key: "customerName", header: "customer_record" },
      { key: "priceCents", header: "service_price_cents" },
      { key: "meetLink", header: "meet_link" },
      { key: "notes", header: "notes" },
      { key: "createdAt", header: "created_at" },
    ]);
    return csvResponse(`appointments-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  } catch (err) {
    return errorResponse(err);
  }
}
