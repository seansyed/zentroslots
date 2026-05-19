/**
 * Routing metrics: auto vs direct assignments + per-staff workload.
 *
 * Derives from the `assignment_mode` column on bookings (set at
 * insert time by /api/bookings) plus the booking → staff_user_id
 * mapping for per-staff counts.
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, users } from "@/db/schema";

export type RoutingDaily = {
  autoAssignments: number;
  directAssignments: number;
  staffAssignments: Record<string, number>;
};

export async function aggregateRoutingMetrics(args: {
  tenantId: string;
  dayStart: Date;
  dayEnd: Date;
}): Promise<RoutingDaily> {
  // Per-staff counts joined to user name for the chart label.
  const rows = await db
    .select({
      staffId: bookings.staffUserId,
      assignmentMode: bookings.assignmentMode,
      staffName: users.name,
    })
    .from(bookings)
    .leftJoin(users, eq(users.id, bookings.staffUserId))
    .where(
      and(
        eq(bookings.tenantId, args.tenantId),
        gte(bookings.startAt, args.dayStart),
        lt(bookings.startAt, args.dayEnd)
      )
    );

  let auto = 0;
  let direct = 0;
  const perStaff: Record<string, number> = {};
  for (const r of rows) {
    if (r.assignmentMode === "auto") auto++;
    else direct++;
    const key = r.staffName ?? r.staffId;
    perStaff[key] = (perStaff[key] ?? 0) + 1;
  }
  return {
    autoAssignments: auto,
    directAssignments: direct,
    staffAssignments: perStaff,
  };
}

void sql;
