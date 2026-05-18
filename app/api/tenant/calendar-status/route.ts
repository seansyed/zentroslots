import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { calendarConnections, calendarSyncLogs, users } from "@/db/schema";
import { errorResponse, requireUser } from "@/lib/auth";
import { recentSyncLogs } from "@/lib/calendar/sync";

// GET /api/tenant/calendar-status
//
// Returns the caller's own calendar connections + recent sync log
// entries. Admin and manager roles see every tenant member's connection
// (useful for "your staff hasn't reconnected" dashboards); staff see
// only their own.
//
// Never returns refresh tokens or any encrypted material. Safe surface
// for the Calendar Connections UI.
export async function GET() {
  try {
    const caller = await requireUser();

    const isManagerial = caller.role === "admin" || caller.role === "manager";

    const connections = await db
      .select({
        id: calendarConnections.id,
        userId: calendarConnections.userId,
        provider: calendarConnections.provider,
        status: calendarConnections.status,
        accountEmail: calendarConnections.accountEmail,
        calendarId: calendarConnections.calendarId,
        scopes: calendarConnections.scopes,
        lastSyncedAt: calendarConnections.lastSyncedAt,
        lastError: calendarConnections.lastError,
        lastErrorAt: calendarConnections.lastErrorAt,
        createdAt: calendarConnections.createdAt,
        updatedAt: calendarConnections.updatedAt,
        userName: users.name,
        userEmail: users.email,
      })
      .from(calendarConnections)
      .leftJoin(users, eq(users.id, calendarConnections.userId))
      .where(
        isManagerial
          ? eq(calendarConnections.tenantId, caller.tenantId)
          : and(
              eq(calendarConnections.tenantId, caller.tenantId),
              eq(calendarConnections.userId, caller.id)
            )
      )
      .orderBy(desc(calendarConnections.updatedAt));

    // Recent activity. For managerial roles, the whole tenant; for
    // staff, just their own connections (filtered server-side).
    const logs = isManagerial
      ? await recentSyncLogs({ tenantId: caller.tenantId, limit: 50 })
      : await db
          .select()
          .from(calendarSyncLogs)
          .where(
            and(
              eq(calendarSyncLogs.tenantId, caller.tenantId),
              eq(calendarSyncLogs.userId, caller.id)
            )
          )
          .orderBy(desc(calendarSyncLogs.createdAt))
          .limit(50);

    return NextResponse.json({ connections, logs });
  } catch (err) {
    return errorResponse(err);
  }
}
