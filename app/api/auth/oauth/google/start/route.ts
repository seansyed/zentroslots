/**
 * GET /api/auth/oauth/google/start
 *
 * Begins the "Continue with Google" auth flow. Generates a CSRF state
 * value, stores it in an httpOnly cookie, and 302-redirects the
 * browser to Google's consent screen.
 *
 * Scopes are intentionally minimal: openid + email + profile.
 * Calendar scopes live in lib/calendar/google.ts and are requested
 * SEPARATELY through the Settings → Calendar Connections flow — auth
 * sessions and calendar tokens never mix.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  buildCallbackUrl,
  generateOAuthState,
  MOBILE_OAUTH_COOKIE,
  mobileOAuthCookieOptions,
  safeNextPath,
  setOAuthStateCookie,
} from "@/lib/auth/oauth";

export const dynamic = "force-dynamic";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const AUTH_SCOPES = ["openid", "email", "profile"];

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Google login isn't configured. Set GOOGLE_CLIENT_ID." },
      { status: 500 },
    );
  }

  // Capture an optional ?next=... redirect target so the callback can
  // send the user back where they intended after auth.
  const url = new URL(req.url);
  const next = safeNextPath(url.searchParams.get("next"));
  // Phase 1A mobile flow — when the native app initiates auth via
  // WebBrowser.openAuthSessionAsync() it appends ?mobile=1. We stash a
  // cookie so the callback can branch to a zentromeet:// deep link
  // instead of setting an httpOnly session cookie. See
  // lib/auth/oauth.ts → mobile section.
  const mobile = url.searchParams.get("mobile") === "1";

  // CSRF state: random 32-byte cookie + same value as ?state= param.
  const state = generateOAuthState();
  await setOAuthStateCookie("google", state);

  const redirectUri = buildCallbackUrl(req, "google");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: AUTH_SCOPES.join(" "),
    // include_granted_scopes lets users who previously granted
    // calendar scopes keep them attached to the token Google issues;
    // we ignore those scopes here either way.
    include_granted_scopes: "true",
    // Force account chooser so users on multi-account browsers see
    // which Google identity they're logging in as.
    prompt: "select_account",
    state,
    // We pass the `next` target through the state→cookie pair would
    // also work but URL-state is simpler since it can't be forged
    // without also forging the cookie (CSRF protection still holds).
    // Use a separate query param the callback reads.
  });
  // Persist `next` in a sibling cookie so the callback can apply it
  // after the auth handshake. Same TTL as the state cookie.
  // (Kept as a cookie rather than encoded in state so state stays a
  // pure CSRF nonce.)
  const res = NextResponse.redirect(`${AUTHORIZE_URL}?${params.toString()}`);
  res.cookies.set("zm_oauth_next", next, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  if (mobile) {
    res.cookies.set(MOBILE_OAUTH_COOKIE, "1", mobileOAuthCookieOptions());
  }
  return res;
}
