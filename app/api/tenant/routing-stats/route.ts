import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { staffAssignmentStats, users } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

// GET /api/tenant/routing-stats
//
// Per-staff assignment stats for the tenant. Powers the lightweight
// analytics stripe on Settings → Staff Routing.
//
// Returns one row per staff member in the tenant — even staff with no
// stat row (they show 0 across the board).
export async function GET() {
  try {
    const admin = await requireRole(["admin", "manager"]);

    const staffRows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.tenantId, admin.tenantId))
      .orderBy(asc(users.name));

    const statRows = await db
      .select()
      .from(staffAssignmentStats)
      .where(eq(staffAssignmentStats.tenantId, admin.tenantId));
    const byStaff = new Map(statRows.map((r) => [r.staffId, r]));

    const todayKey = new Date().toISOString().slice(0, 10);

    const enriched = staffRows
      .filter((s) => s.role !== "client")
      .map((s) => {
        const row = byStaff.get(s.id);
        // Apply the rolling-window decision INLINE so a stale counter
        // doesn't show last week's "today" count.
        const sameDay =
          row?.dayWindowStart && row.dayWindowStart.toISOString().slice(0, 10) === todayKey;
        return {
          staffId: s.id,
          staffName: s.name,
          staffEmail: s.email,
          totalAssignments: row?.totalAssignments ?? 0,
          assignmentsToday: sameDay ? row!.assignmentsToday : 0,
          assignmentsThisWeek: row?.assignmentsThisWeek ?? 0, // simpler: shows whatever the recorder maintained
          lastAssignedAt: row?.lastAssignedAt ?? null,
        };
      });

    return NextResponse.json({ stats: enriched });
  } catch (err) {
    return errorResponse(err);
  }
}
