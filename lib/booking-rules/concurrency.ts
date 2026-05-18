/**
 * Concurrency check.
 *
 * Counts CONFIRMED bookings for this service whose window overlaps the
 * requested (startAt, endAt). If the count is at or above the
 * configured cap, the booking is rejected.
 *
 * IMPORTANT: this is additive pre-validation only — the EXCLUDE
 * constraint remains the authoritative backstop AT THE PER-STAFF
 * LEVEL. EXCLUDE rejects two bookings for the SAME staff at the same
 * time. Concurrency rejects more than N simultaneous bookings for the
 * SAME service across all staff. The two work together — neither
 * replaces the other.
 *
 * Tenant isolation: scoped to (tenantId, serviceId).
 */
import { and, eq, gte, lt } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings } from "@/db/schema";

export async function countConcurrentForService(args: {
  tenantId: string;
  serviceId: string;
  startAt: Date;
  endAt: Date;
}): Promise<number> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        eq(bookings.serviceId, args.serviceId),
        eq(bookings.status, "confirmed"),
        // Overlap test: existing.endAt > requested.start
        //              AND existing.startAt < requested.end
        gte(bookings.endAt, args.startAt),
        lt(bookings.startAt, args.endAt)
      )
    );
  return rows.length;
}
