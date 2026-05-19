/**
 * POST /api/auth/sessions/revoke-all
 *
 * Bulk-revokes every session for the currently-authenticated user by
 * bumping users.sessionMinIat to now. EVERY existing token (jti or
 * legacy) with iat before this moment will be rejected by
 * verifySessionFresh() on next use.
 *
 * Then re-issues the CURRENT cookie so the user stays signed in on
 * this device. Other devices (with stale iat) are forced to sign in.
 *
 * Requires a fresh session (verifySessionFresh) — additional
 * defense-in-depth against a stolen cookie performing this action.
 */

import { NextRequest, NextResponse } from "next/server";

import { ipFromHeaders } from "@/lib/audit";
import {
  createTokenWithJti,
  errorResponse,
  HttpError,
  revokeAllSessionsForUser,
  setSessionCookie,
  verifySessionFresh,
} from "@/lib/auth";
import { recordSessionEvent, userAgentFromHeaders } from "@/lib/security/sessionEvents";
import { recordSecurityAudit } from "@/lib/security/audit";
import { deviceLabelFor } from "@/lib/security/heuristics";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const fresh = await verifySessionFresh();
    if (!fresh.ok) throw new HttpError(401, "Unauthorized");

    const ip = ipFromHeaders(req.headers);
    const userAgent = userAgentFromHeaders(req.headers);

    await revokeAllSessionsForUser(fresh.user.id);

    // Re-issue this device's cookie with a fresh iat so the user
    // doesn't immediately log themselves out.
    const { token, jti } = await createTokenWithJti({
      sub: fresh.user.id,
      role: fresh.user.role,
      email: fresh.user.email,
      tenantId: fresh.user.tenantId,
    });
    await setSessionCookie(token);

    await recordSessionEvent({
      tenantId: fresh.user.tenantId,
      userId: fresh.user.id,
      eventType: "sessions_revoked_all",
      sessionJti: jti,
      ipAddress: ip,
      userAgent,
      deviceLabel: deviceLabelFor(userAgent),
      metadata: { kept_current_session: true },
    });

    await recordSecurityAudit({
      tenantId: fresh.user.tenantId,
      category: "security.sessions.revoked_all",
      actorUserId: fresh.user.id,
      actorLabel: fresh.user.name,
      ipAddress: ip,
      metadata: { kept_current_session: true },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
