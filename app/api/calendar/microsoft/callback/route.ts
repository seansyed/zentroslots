import { NextRequest, NextResponse } from "next/server";

import { errorResponse, getSession, HttpError } from "@/lib/auth";
import { exchangeCode } from "@/lib/calendar/microsoft";
import { upsertMicrosoftConnection } from "@/lib/calendar/sync";
import { audit, ipFromHeaders } from "@/lib/audit";

const APP_BASE_URL = process.env.APP_BASE_URL ?? "http://localhost:3001";

// GET /api/calendar/microsoft/callback — Wave C
//
// Handles the OAuth redirect from Microsoft's identity platform.
// Validates `state === session.user.id`, exchanges the code for
// tokens, encrypts + persists via the orchestrator, then redirects
// back to the Calendar Connections page with a success/error flash.
//
// Mirrors /api/calendar/google/callback. Two providers, one shape —
// the orchestrator owns the per-provider encryption + persistence
// differences (Microsoft caches access tokens; Google's SDK manages
// them internally).
export async function GET(req: NextRequest) {
  try {
    const code = req.nextUrl.searchParams.get("code");
    const state = req.nextUrl.searchParams.get("state");
    const errParam = req.nextUrl.searchParams.get("error");
    const errDesc = req.nextUrl.searchParams.get("error_description");

    if (errParam) {
      // User declined consent, or Microsoft surfaced an admin-consent
      // requirement (AADSTS65001 etc). Surface the raw error code on
      // the calendar settings page so support can diagnose without
      // a log dive. error_description is informational only and not
      // safe to pass through unsanitized — we keep just the short
      // machine code.
      const safe = errParam.slice(0, 80);
      const u = `${APP_BASE_URL}/dashboard/settings/calendar?error=${encodeURIComponent(safe)}`;
      void errDesc;
      return NextResponse.redirect(u);
    }
    if (!code || !state) throw new HttpError(400, "Missing code/state");

    const session = await getSession();
    if (!session) throw new HttpError(401, "Sign in before connecting Microsoft");
    if (session.sub !== state) throw new HttpError(403, "OAuth state mismatch");

    const tokens = await exchangeCode(code);
    const connectionId = await upsertMicrosoftConnection({
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
      metadata: { provider: "microsoft", accountEmail: tokens.email },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.redirect(
      `${APP_BASE_URL}/dashboard/settings/calendar?connected=microsoft`,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
