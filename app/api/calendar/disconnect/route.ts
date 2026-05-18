import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { calendarSyncLogs, users } from "@/db/schema";
import { errorResponse, HttpError, isManagerial, requireUser } from "@/lib/auth";
import { disconnect, getConnectionForTenant } from "@/lib/calendar/sync";
import { audit, ipFromHeaders } from "@/lib/audit";

const bodySchema = z.object({
  connectionId: z.string().uuid(),
});

// POST /api/calendar/disconnect
//
// Disconnects a single calendar connection. Users can always disconnect
// their own; managerial roles (admin/manager) can disconnect any user's
// connection inside the tenant. Tenant isolation enforced via
// getConnectionForTenant() — cross-tenant ids return 404.
//
// Effect: status → 'disconnected', refresh token wiped, sync log row
// recorded. The booking lifecycle hooks short-circuit on disconnected
// connections — no further sync writes happen until reconnect.
export async function POST(req: NextRequest) {
  try {
    const caller = await requireUser();
    const body = bodySchema.parse(await req.json());

    const conn = await getConnectionForTenant(caller.tenantId, body.connectionId);
    if (!conn) throw new HttpError(404, "Connection not found");

    // Authorization: self or managerial.
    if (conn.userId !== caller.id && !isManagerial(caller.role)) {
      throw new HttpError(403, "Forbidden");
    }

    await disconnect(conn.id);

    // Also clear the legacy users.google_* columns so the old
    // IntegrationsClient stops showing "connected" for this user.
    await db
      .update(users)
      .set({
        googleRefreshToken: null,
        googleStatus: null,
        googleLastErrorAt: null,
      })
      .where(and(eq(users.id, conn.userId), eq(users.tenantId, caller.tenantId)));

    audit({
      tenantId: caller.tenantId,
      action: "calendar.disconnect",
      actorUserId: caller.id,
      actorLabel: caller.email,
      entityType: "calendar_connection",
      entityId: conn.id,
      metadata: { provider: conn.provider, targetUserId: conn.userId },
      ipAddress: ipFromHeaders(req.headers),
    });

    // Log the disconnect event so it appears in the sync log table.
    await db.insert(calendarSyncLogs).values({
      tenantId: caller.tenantId,
      connectionId: conn.id,
      userId: conn.userId,
      provider: conn.provider,
      kind: "disconnect",
      status: "ok",
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
