import { NextRequest, NextResponse } from "next/server";

import { errorResponse, getSession, HttpError } from "@/lib/auth";
import { exchangeCode } from "@/lib/calendar/zoom";
import { upsertZoomConnection } from "@/lib/calendar/sync";
import { audit, ipFromHeaders } from "@/lib/audit";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

// GET /api/calendar/zoom/callback — Wave D
//
// Handles the OAuth redirect from Zoom. Same shape as the Google +
// Microsoft callbacks: validate state == session.user.id, exchange
// the code for tokens, encrypt + persist via the orchestrator, then
// redirect back to the Calendar Connections page with a flash.
//
// Zoom error response shape on declined consent: `?error=access_denied`
// — surface only the safe machine code, not error_description (Zoom
// occasionally puts long descriptions there).
export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const errParam = req.nextUrl.searchParams.get("error");

    if (errParam) {
      const safe = errParam.slice(0, 80);
      return NextResponse.redirect(
        `${APP_BASE_URL}/dashboard/settings/calendar?error=${encodeURIComponent(safe)}`,
      );
    }
    if (!code || !state) throw new HttpError(400, "Missing code/state");

    const session = await getSession();
    if (!session) throw new HttpError(401, "Sign in before connecting Zoom");
    if (session.sub !== state) throw new HttpError(403, "OAuth state mismatch");

    const tokens = await exchangeCode(code);
    const connectionId = await upsertZoomConnection({
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
      metadata: { provider: "zoom", accountEmail: tokens.email },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.redirect(
      `${APP_BASE_URL}/dashboard/settings/calendar?connected=zoom`,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
