import { NextRequest, NextResponse } from "next/server";

import { errorResponse, getSession, HttpError } from "@/lib/auth";
import { exchangeCode } from "@/lib/calendar/google";
import { upsertGoogleConnection } from "@/lib/calendar/sync";
import { audit, ipFromHeaders } from "@/lib/audit";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

// GET /api/calendar/google/callback
//
// Handles the OAuth redirect from Google. Validates state == session
// user id, exchanges code for tokens, encrypts + persists via the
// orchestrator, then redirects back to the Calendar Connections page.
//
// Replaces the legacy /api/google/callback. We can keep both alive
// without conflict because OAuth redirect URIs are explicit env vars —
// flip the redirect URI in Google Cloud Console once this lands.
export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const errParam = req.nextUrl.searchParams.get("error");

    if (errParam) {
      // User clicked "Cancel" on Google's consent screen — friendly redirect.
      return NextResponse.redirect(
        `${APP_BASE_URL}/dashboard/settings/calendar?error=${encodeURIComponent(errParam)}`
      );
    }
    if (!code || !state) throw new HttpError(400, "Missing code/state");

    const session = await getSession();
    if (!session) throw new HttpError(401, "Sign in before connecting Google");
    if (session.sub !== state) throw new HttpError(403, "OAuth state mismatch");

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
      metadata: { provider: "google", accountEmail: tokens.email },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.redirect(
      `${APP_BASE_URL}/dashboard/settings/calendar?connected=google`
    );
  } catch (err) {
    return errorResponse(err);
  }
}
