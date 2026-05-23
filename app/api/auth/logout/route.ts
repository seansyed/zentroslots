import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, getSession, revokeSessionJti } from "@/lib/auth";
import { publicUrl } from "@/lib/auth/oauth";
import { ipFromHeaders } from "@/lib/audit";
import { recordSessionEvent, userAgentFromHeaders } from "@/lib/security/sessionEvents";
import { deviceLabelFor } from "@/lib/security/heuristics";

/**
 * POST /api/auth/logout
 *
 * Clears the session cookie, revokes the jti, records the logout
 * event, then responds with a 303 See Other redirect to
 * /dashboard/login.
 *
 * Why 303 instead of JSON:
 *   The Sidebar + Topbar log-out controls are plain HTML `<form
 *   method="POST">` elements (no fetch). When the route returned
 *   `{ ok: true }` JSON the browser displayed the raw payload
 *   instead of returning the user to the login page — the form
 *   was effectively dead-ending. POST-redirect-GET via 303 is the
 *   correct REST pattern here and is supported by every browser.
 *
 * Why publicUrl():
 *   Behind the Caddy reverse proxy, `req.url` resolves to the
 *   internal http://localhost:3001 origin; passing it to
 *   `new URL(path, req.url)` would emit a Location header pointing
 *   at localhost, which browsers can't reach. The publicUrl helper
 *   honors x-forwarded-host (same pattern the OAuth callbacks use).
 */
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

  // 303 See Other forces the browser to issue a GET on the redirect
  // target, which is what we want after a POST. Returns the user to
  // the public login surface.
  return NextResponse.redirect(publicUrl(req, "/dashboard/login"), {
    status: 303,
  });
}

/**
 * GET /api/auth/logout
 *
 * Convenience handler for users who type the logout URL directly,
 * follow a bookmark, or click a link that uses GET. Clears the
 * cookie (same as POST) and redirects to /dashboard/login.
 *
 * Logout-via-GET is intentionally cheap to invoke — it's terminal,
 * idempotent, and the user is already authenticated to themselves
 * by virtue of holding the cookie. There's no destructive side
 * effect a CSRF attacker could exploit beyond annoying the user.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (session) {
    try {
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
  return NextResponse.redirect(publicUrl(req, "/dashboard/login"), {
    status: 303,
  });
}
