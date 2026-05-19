import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, getSession, revokeSessionJti } from "@/lib/auth";
import { ipFromHeaders } from "@/lib/audit";
import { recordSessionEvent, userAgentFromHeaders } from "@/lib/security/sessionEvents";
import { deviceLabelFor } from "@/lib/security/heuristics";

export async function POST(req: NextRequest) {
  const session = await getSession();
  // Record the logout event BEFORE clearing the cookie so the event
  // is attributed to the user that owned the cookie.
  if (session) {
    try {
      // Also revoke the jti so a stolen cookie can't be replayed.
      // No-op for legacy tokens (no jti).
      if (session.jti) {
        await revokeSessionJti({
          jti: session.jti,
          userId: session.sub,
          reason: "user_logout",
        });
      }
      await recordSessionEvent({
        tenantId: session.tenantId,
        userId: session.sub,
        eventType: "logout",
        sessionJti: session.jti ?? null,
        ipAddress: ipFromHeaders(req.headers),
        userAgent: userAgentFromHeaders(req.headers),
        deviceLabel: deviceLabelFor(userAgentFromHeaders(req.headers)),
      });
    } catch (err) {
      console.error("[auth] logout event recording failed:", err);
    }
  }
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
