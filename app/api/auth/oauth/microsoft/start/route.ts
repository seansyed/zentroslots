/**
 * GET /api/auth/oauth/microsoft/start
 *
 * "Continue with Microsoft" entry point. Generates state, sets the
 * CSRF cookie, redirects to the Microsoft identity platform's common
 * tenant authorize endpoint (supports both Microsoft 365 work/school
 * accounts AND personal accounts).
 *
 * Scopes are minimal auth-only: openid + email + profile + User.Read.
 * Calendar scopes live in lib/calendar/microsoft.ts and are requested
 * SEPARATELY through the Settings → Calendar Connections flow.
 *
 * Reuses MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET env vars; the
 * Azure AD app needs both this redirect URI AND the calendar
 * redirect URI listed in its Redirect URIs config.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  buildCallbackUrl,
  generateOAuthState,
  safeNextPath,
  setOAuthStateCookie,
} from "@/lib/auth/oauth";

export const dynamic = "force-dynamic";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const AUTH_SCOPES = ["openid", "email", "profile", "User.Read"];

export async function GET(req: NextRequest) {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Microsoft login isn't configured. Set MICROSOFT_CLIENT_ID." },
      { status: 500 },
    );
  }

  const url = new URL(req.url);
  const next = safeNextPath(url.searchParams.get("next"));

  const state = generateOAuthState();
  await setOAuthStateCookie("microsoft", state);

  const redirectUri = buildCallbackUrl(req, "microsoft");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: AUTH_SCOPES.join(" "),
    // Force account picker so multi-account users see the chooser.
    prompt: "select_account",
    state,
  });

  const res = NextResponse.redirect(`${AUTHORIZE_URL}?${params.toString()}`);
  res.cookies.set("zm_oauth_next", next, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
