/**
 * GET /api/auth/oauth/google/callback
 *
 * Google redirects here after the user grants consent. We:
 *   1. Validate the CSRF state cookie matches the URL state param.
 *   2. Exchange the auth code for an ID token + access token (no
 *      refresh token requested — auth flow doesn't need long-lived
 *      offline access; calendar flow handles that separately).
 *   3. Decode the ID token's `email` + `email_verified` + `name`.
 *      Reject if email isn't verified.
 *   4. Find-or-create the user via the shared OAuth helpers; issue a
 *      ZentroMeet session cookie identical in shape to the one the
 *      password-login route mints.
 *   5. Redirect to /dashboard (or the `next` cookie target).
 *
 * Failure modes bounce the user back to /dashboard/login with a
 * ?error= query so the login page can render a clean inline message.
 */

import { NextRequest, NextResponse } from "next/server";

import {
  buildCallbackUrl,
  consumeOAuthStateCookie,
  enrichUserProfileFromOAuth,
  findOrCreateUserForOAuth,
  issueOAuthSession,
  publicUrl,
  safeNextPath,
} from "@/lib/auth/oauth";

export const dynamic = "force-dynamic";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

type GoogleTokenResponse = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type GoogleIdTokenClaims = {
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  given_name?: string;
  family_name?: string;
  /** Phase 17I-8 — Google sets this on the ID token when `profile`
   *  scope is requested (already in our scope set). URL points at
   *  the user's Google profile photo on lh3.googleusercontent.com.
   *  We download it server-side and cache locally so expired
   *  provider URLs don't leak into the UI. */
  picture?: string;
  sub?: string;
};

function loginError(req: NextRequest, code: string): NextResponse {
  // IMPORTANT: build the redirect against the PUBLIC host (Caddy/nginx
  // forwarded host), NOT req.url — req.url resolves to the internal
  // http://localhost:3001 origin behind the proxy and would land
  // users on an unreachable URL.
  const target = publicUrl(req, "/dashboard/login");
  target.searchParams.set("error", code);
  return NextResponse.redirect(target);
}

/** Decode the payload section of a JWT WITHOUT verifying the
 *  signature. We're safe doing this because the ID token came over a
 *  direct TLS-only POST to Google's token endpoint — there's no
 *  intermediary. For belt-and-suspenders we still inspect
 *  email_verified before issuing a session. */
function decodeIdToken(idToken: string): GoogleIdTokenClaims | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1];
    // base64url → utf8 string → JSON
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  // User cancelled OR Google returned an error to the redirect.
  if (providerError) {
    return loginError(req, providerError === "access_denied" ? "cancelled" : "provider_error");
  }
  if (!code || !state) {
    return loginError(req, "invalid_callback");
  }

  // CSRF state check.
  const stateOk = await consumeOAuthStateCookie("google", state);
  if (!stateOk) {
    return loginError(req, "state_mismatch");
  }

  // Exchange code for tokens.
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return loginError(req, "not_configured");
  }
  const redirectUri = buildCallbackUrl(req, "google");

  let tokens: GoogleTokenResponse;
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    tokens = (await tokenRes.json()) as GoogleTokenResponse;
    if (!tokenRes.ok || tokens.error || !tokens.id_token) {
      console.error("[oauth/google] token exchange failed:", tokens);
      return loginError(req, "token_exchange_failed");
    }
  } catch (e) {
    console.error("[oauth/google] token exchange threw:", e);
    return loginError(req, "token_exchange_failed");
  }

  // Decode the ID token + enforce email_verified.
  const claims = decodeIdToken(tokens.id_token);
  if (!claims?.email) {
    return loginError(req, "missing_email");
  }
  // Google's email_verified comes through as either a boolean or the
  // literal strings "true"/"false" depending on the SDK path. Accept
  // both shapes; reject anything else.
  const verified =
    claims.email_verified === true || claims.email_verified === "true";
  if (!verified) {
    return loginError(req, "email_not_verified");
  }

  // Resolve identity → user/session.
  let resolvedUserId: string | null = null;
  let isNewUser = false;
  try {
    const result = await findOrCreateUserForOAuth({
      email: claims.email,
      name: claims.name ?? null,
      provider: "google",
    });
    await issueOAuthSession({
      userId: result.userId,
      provider: "google",
      req,
    });
    resolvedUserId = result.userId;
    isNewUser = result.isNewUser;
  } catch (e) {
    console.error("[oauth/google] session mint failed:", e);
    return loginError(req, "session_mint_failed");
  }

  // Phase 17I-8 — profile enrichment (avatar + name refresh). Runs
  // AFTER the session cookie is set so we never block login latency
  // on a slow provider image. Fire-and-forget; failure is logged but
  // never surfaces to the user. Topbar + Sidebar already lazy-fetch
  // /api/auth/me on mount, so the avatar appears as soon as it's
  // written (typically <300ms, ahead of /dashboard mount).
  if (resolvedUserId && claims.picture) {
    void enrichUserProfileFromOAuth({
      userId: resolvedUserId,
      identity: {
        email: claims.email,
        name: claims.name ?? null,
        provider: "google",
        pictureUrl: claims.picture,
      },
    }).catch((e) => {
      console.warn("[oauth/google] profile enrichment failed (non-fatal):", e);
    });
  }

  // Consume the `next` cookie if present; default to /dashboard.
  const nextCookie = req.cookies.get("zm_oauth_next")?.value;
  const nextPath = safeNextPath(nextCookie);

  // Phase GA4 — server-to-client event signal. New OAuth identity →
  // `signup_completed`; returning user → no event (a login is not a
  // conversion). GAProvider strips the param after firing, so no
  // re-fire on back/forward navigation. We attach `ga_provider=google`
  // so dashboards can split signup-by-provider.
  const target = publicUrl(req, nextPath);
  if (isNewUser) {
    target.searchParams.set("ga_event", "signup_completed");
    target.searchParams.set("ga_provider", "google");
  }
  const res = NextResponse.redirect(target);
  res.cookies.delete("zm_oauth_next");
  return res;
}
