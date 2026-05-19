/**
 * Booking metrics for one (tenant, day) window.
 *
 * "Day" means UTC [dayStart, dayStart+24h). The aggregation worker
 * builds the day window once and passes it to each metric module.
 *
 * Counts use bookings.start_at AS the bucket — i.e. "how many
 * appointments started today" — which matches the customer-facing
 * mental model of analytics.
 */
import { and, count, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services } from "@/db/schema";

export type BookingCounts = {
  total: number;
  completed: number;
  cancelled: number;
  noShow: number;
  recurring: number;
  averageBookingLeadHours: number | null;
  servicePopularity: Record<string, number>;
  hourDistribution: number[];
  weekdayDistribution: number[];
};

export async function aggregateBookingMetrics(args: {
  tenantId: string;
  dayStart: Date;
  dayEnd: Date;
}): Promise<BookingCounts> {
  // One pass over the day's bookings — covers counts + lead time +
  // distributions in a single read.
  const rows = await db
    .select({
      id: bookings.id,
      status: bookings.status,
      startAt: bookings.startAt,
      createdAt: bookings.createdAt,
      serviceId: bookings.serviceId,
      bookingSeriesId: bookings.bookingSeriesId,
      serviceName: services.name,
    })
    .from(bookings)
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        gte(bookings.startAt, args.dayStart),
        lt(bookings.startAt, args.dayEnd)
      )
    );

  const counts: BookingCounts = {
    total: rows.length,
    completed: 0,
    cancelled: 0,
    noShow: 0,
    recurring: 0,
    averageBookingLeadHours: null,
    servicePopularity: {},
    hourDistribution: new Array(24).fill(0),
    weekdayDistribution: new Array(7).fill(0),
  };

  let leadSumMs = 0;
  let leadCount = 0;

  for (const r of rows) {
    if (r.status === "completed") counts.completed++;
    else if (r.status === "cancelled") counts.cancelled++;
    else if (r.status === "no_show") counts.noShow++;
    if (r.bookingSeriesId) counts.recurring++;

    const key = r.serviceName ?? r.serviceId;
    counts.servicePopularity[key] = (counts.servicePopularity[key] ?? 0) + 1;

    counts.hourDistribution[r.startAt.getUTCHours()]++;
    counts.weekdayDistribution[r.startAt.getUTCDay()]++;

    // Lead time only meaningful for non-cancelled bookings.
    if (r.status !== "cancelled") {
      const lead = r.startAt.getTime() - r.createdAt.getTime();
      if (lead > 0) {
        leadSumMs += lead;
        leadCount++;
      }
    }
  }

  if (leadCount > 0) {
    counts.averageBookingLeadHours = Math.round(leadSumMs / leadCount / 3_600_000);
  }

  return counts;
}

// Re-exported for future fan-out helpers; unused import guard.
void count;
void isNotNull;
void sql;
