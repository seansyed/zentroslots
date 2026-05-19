/**
 * GET /api/auth/sessions
 *
 * Returns the current user's recent session-audit events: logins,
 * logouts, failures, suspicious events, password resets, revocations.
 *
 * Tenant-scoped via the requireUser() session; never reveals events
 * for another user. Limits to the last 50 events by default.
 *
 * The "active sessions" model in this stateless-JWT system is
 * approximate: we surface the most recent successful logins per jti
 * that haven't been individually revoked. Combined with the current
 * cookie's jti, the UI can mark "this device" vs others.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { revokedSessionJtis, sessionAuditEvents } from "@/db/schema";
import { errorResponse, getSession, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const user = await requireUser();
    const session = await getSession(); // for current jti highlight
    const events = await db
      .select()
      .from(sessionAuditEvents)
      .where(and(eq(sessionAuditEvents.tenantId, user.tenantId), eq(sessionAuditEvents.userId, user.id)))
      .orderBy(desc(sessionAuditEvents.createdAt))
      .limit(50);

    // Build a "sessions" view: each distinct jti from a login event
    // that hasn't been revoked.
    const loginEvents = events.filter((e) => e.eventType === "login" && e.sessionJti);
    const jtis = Array.from(new Set(loginEvents.map((e) => e.sessionJti!)));
    const revokedRows = jtis.length
      ? await db
          .select({ jti: revokedSessionJtis.jti, revokedAt: revokedSessionJtis.revokedAt })
          .from(revokedSessionJtis)
      : [];
    const revokedSet = new Map(revokedRows.map((r) => [r.jti, r.revokedAt]));

    const sessions = loginEvents.map((e) => ({
      jti: e.sessionJti!,
      loggedInAt: e.createdAt,
      ipAddress: e.ipAddress,
      userAgent: e.userAgent,
      deviceLabel: e.deviceLabel,
      isCurrent: session?.jti === e.sessionJti,
      revoked: revokedSet.has(e.sessionJti!),
      revokedAt: revokedSet.get(e.sessionJti!) ?? null,
    }));

    return NextResponse.json({
      currentJti: session?.jti ?? null,
      sessions,
      events,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
