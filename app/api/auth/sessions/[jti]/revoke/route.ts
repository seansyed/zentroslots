/**
 * POST /api/auth/sessions/:jti/revoke
 *
 * Revoke a single session by its JWT id. The dashboard's "Sign out
 * this device" button hits this.
 *
 * Tenant-isolation: the jti must belong to a session we recorded
 * for the calling user. We check this by looking up a matching
 * session_audit_events row keyed by (userId, jti).
 *
 * Requires verifySessionFresh — same defense-in-depth as revoke-all.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { sessionAuditEvents } from "@/db/schema";
import { ipFromHeaders } from "@/lib/audit";
import {
  errorResponse,
  HttpError,
  revokeSessionJti,
  verifySessionFresh,
} from "@/lib/auth";
import { recordSessionEvent, userAgentFromHeaders } from "@/lib/security/sessionEvents";
import { recordSecurityAudit } from "@/lib/security/audit";
import { deviceLabelFor } from "@/lib/security/heuristics";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ jti: string }> }
) {
  try {
    const fresh = await verifySessionFresh();
    if (!fresh.ok) throw new HttpError(401, "Unauthorized");

    const { jti } = await context.params;
    if (!jti || jti.length > 64) throw new HttpError(400, "Invalid session id");

    // Verify this jti was issued to the calling user — prevents
    // revoking another user's session.
    const ownership = await db
      .select({ id: sessionAuditEvents.id })
      .from(sessionAuditEvents)
      .where(
        and(
          eq(sessionAuditEvents.userId, fresh.user.id),
          eq(sessionAuditEvents.sessionJti, jti)
        )
      )
      .limit(1);
    if (ownership.length === 0) {
      // Treat as a not-found rather than 403 to avoid leaking
      // which jtis exist.
      throw new HttpError(404, "Session not found");
    }

    await revokeSessionJti({ jti, userId: fresh.user.id, reason: "user_revoke" });

    const ip = ipFromHeaders(req.headers);
    const userAgent = userAgentFromHeaders(req.headers);
    await recordSessionEvent({
      tenantId: fresh.user.tenantId,
      userId: fresh.user.id,
      eventType: "session_revoked",
      sessionJti: jti,
      ipAddress: ip,
      userAgent,
      deviceLabel: deviceLabelFor(userAgent),
    });

    await recordSecurityAudit({
      tenantId: fresh.user.tenantId,
      category: "security.session.revoked",
      actorUserId: fresh.user.id,
      actorLabel: fresh.user.name,
      entityType: "session",
      entityId: jti,
      ipAddress: ip,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
