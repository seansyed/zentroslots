import { NextResponse } from "next/server";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, users } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";

export async function GET() {
  try {
    const caller = await requireUser();

    const staffRows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        timezone: users.timezone,
        role: users.role,
        avatarUrl: users.avatarUrl,
        bio: users.bio,
        specialties: users.specialties,
        googleConnected: sql<boolean>`(${users.googleRefreshToken} IS NOT NULL)`,
        createdAt: users.createdAt,
      })
      .from(users)
      // Show both 'staff' and 'manager' rows here — managers are an
      // ops-team member with extra power, but UI-wise live in the same
      // "Staff" page.
      .where(and(eq(users.tenantId, caller.tenantId), inArray(users.role, ["staff", "manager"])));

    // Stats: upcoming + completed counts per staff member.
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const upcoming = await db
      .select({
        staffUserId: bookings.staffUserId,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, caller.tenantId),
          eq(bookings.status, "confirmed"),
          gte(bookings.startAt, now)
        )
      )
      .groupBy(bookings.staffUserId);

    const completedThisMonth = await db
      .select({
        staffUserId: bookings.staffUserId,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(bookings)
      .where(
        and(
          eq(bookings.tenantId, caller.tenantId),
          eq(bookings.status, "completed"),
          gte(bookings.startAt, monthStart)
        )
      )
      .groupBy(bookings.staffUserId);

    const upMap = new Map(upcoming.map((r) => [r.staffUserId, Number(r.n)]));
    const compMap = new Map(completedThisMonth.map((r) => [r.staffUserId, Number(r.n)]));

    return NextResponse.json(
      staffRows.map((s) => ({
        ...s,
        upcomingCount: upMap.get(s.id) ?? 0,
        completedThisMonth: compMap.get(s.id) ?? 0,
      }))
    );
  } catch (err) {
    return errorResponse(err);
  }
}
