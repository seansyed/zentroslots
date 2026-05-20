import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { calendarConnections, users } from "@/db/schema";
import { errorResponse, HttpError, isManagerial, requireUser } from "@/lib/auth";

// GET /api/users/[id]/calendar-connections
//
// Per-staff list of calendar connections — used by the Staff Profile
// tab's Calendar Connections section. Returns the same per-(user,
// provider) shape as /dashboard/settings/calendar, but scoped to a
// single user so the Profile tab can render without a workspace-wide
// fetch.
//
// Identity gate: caller may read their own connections OR be
// admin/manager in the same tenant as the target user. Cross-tenant
// targets always return 404 (never disclose existence cross-tenant).
//
// Sync-health derivation:
//   • lastSyncedAt + lastError + lastErrorAt are surfaced as-is so
//     the UI can render "Connected · last synced 3m ago",
//     "Needs reconnect", "Sync issue detected" etc. without
//     additional joins.

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const caller = await requireUser();
    const { id } = await context.params;

    // Identity gate.
    if (caller.id !== id) {
      if (!isManagerial(caller.role)) {
        throw new HttpError(403, "Forbidden");
      }
      const target = await db.query.users.findFirst({
        where: and(eq(users.id, id), eq(users.tenantId, caller.tenantId)),
      });
      if (!target) throw new HttpError(404, "User not found");
    }

    const rows = await db
      .select({
        id: calendarConnections.id,
        provider: calendarConnections.provider,
        status: calendarConnections.status,
        calendarId: calendarConnections.calendarId,
        accountEmail: calendarConnections.accountEmail,
        lastSyncedAt: calendarConnections.lastSyncedAt,
        lastError: calendarConnections.lastError,
        lastErrorAt: calendarConnections.lastErrorAt,
        createdAt: calendarConnections.createdAt,
        updatedAt: calendarConnections.updatedAt,
      })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.userId, id),
          eq(calendarConnections.tenantId, caller.tenantId),
        ),
      )
      .orderBy(desc(calendarConnections.updatedAt));

    return NextResponse.json({ connections: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
