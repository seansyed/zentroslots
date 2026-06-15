import { NextRequest, NextResponse } from "next/server";

import { errorResponse, getSession, HttpError } from "@/lib/auth";
import { exchangeCode } from "@/lib/calendar/google";
import { upsertGoogleConnection } from "@/lib/calendar/sync";
import { audit, ipFromHeaders } from "@/lib/audit";
import { consumeCalendarStateCookie } from "@/lib/calendar/oauth-state";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

/**
 * Legacy entry point: GET /api/google/callback
 *
 * Wave A — fully migrated to the orchestrator pipeline:
 *   • code exchange via lib/calendar/google.exchangeCode
 *   • encrypted persistence via lib/calendar/sync.upsertGoogleConnection
 *   • no more plaintext writes to users.google_refresh_token
 *
 * Behaviorally identical to /api/calendar/google/callback. We keep this
 * legacy URL alive because OAuth redirect URIs are registered with
 * Google Cloud Console — flipping them requires a synchronized env +
 * console change, which we'll do in a separate ops task. Until then
 * both URLs work; both end up at the same connection row.
 */
export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const errParam = req.nextUrl.searchParams.get("error");

    if (errParam) {
      return NextResponse.redirect(
        `${APP_BASE_URL}/dashboard/settings/calendar?error=${encodeURIComponent(errParam)}`,
      );
    }
    if (!code || !state) throw new HttpError(400, "Missing code/state");

    const session = await getSession();
    if (!session) throw new HttpError(401, "Sign in before connecting Google");
    // CSRF: verify the single-use state nonce against the httpOnly cookie
    // set at /connect (the legacy connect now 307s to the calendar connect
    // route, which sets the same `zm_cal_state_google` cookie). User comes
    // from the verified session, not from `state`.
    if (!(await consumeCalendarStateCookie("google", state))) {
      throw new HttpError(403, "OAuth state mismatch");
    }

    const tokens = await exchangeCode(code);
    const connectionId = await upsertGoogleConnection({
      tenantId: session.tenantId,
      userId: session.sub,
      refreshTokenPlain: tokens.refreshToken,
      accessTokenPlain: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      accountEmail: tokens.email,
      scopes: tokens.scope,
    });

    audit({
      tenantId: session.tenantId,
      action: "calendar.connect",
      actorUserId: session.sub,
      actorLabel: session.email,
      entityType: "calendar_connection",
      entityId: connectionId,
      metadata: { provider: "google", accountEmail: tokens.email, via: "legacy_callback" },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.redirect(`${APP_BASE_URL}/dashboard?google=connected`);
  } catch (err) {
    return errorResponse(err);
  }
}
