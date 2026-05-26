/**
 * GET /api/auth/oauth/microsoft/callback
 *
 * Microsoft identity platform redirects here after consent. We:
 *   1. Validate the CSRF state cookie.
 *   2. Exchange the auth code for an access token + id_token at the
 *      common tenant endpoint.
 *   3. Decode the id_token to read the user's `email` / `preferred_
 *      username` / `name`. Microsoft's id_token does NOT carry an
 *      `email_verified` claim — for work/school (Azure AD) accounts
 *      the email IS the directory identifier so it's implicitly
 *      verified; for personal MSA accounts the email is also verified
 *      by Microsoft. Industry standard treats this email as verified.
 *   4. Resolve identity via the shared helpers + mint a ZentroMeet
 *      session.
 *   5. Redirect to /dashboard (or the captured `next` cookie target).
 *
 * Failures bounce to /dashboard/login?error= so the login page can
 * render a clean inline message.
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

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

type MicrosoftTokenResponse = {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

type MicrosoftIdTokenClaims = {
  /** Microsoft's id_token uses `preferred_username` for the
   *  primary email-style identifier on personal MSA accounts and
   *  `email` on work/school. We accept either; preferred_username
   *  is the more reliable cross-account field. */
  email?: string;
  preferred_username?: string;
  name?: string;
  /** Issuer — `https://login.microsoftonline.com/{tid}/v2.0` for
   *  work/school, `https://login.microsoftonline.com/9188040d-...-
   *  ...d/v2.0` for personal MSA. We accept both. */
  iss?: string;
  oid?: string;
  sub?: string;
};

function loginError(req: NextRequest, code: string): NextResponse {
  // Public-host redirect — see google/callback/route.ts for the
  // reverse-proxy rationale.
  const target = publicUrl(req, "/dashboard/login");
  target.searchParams.set("error", code);
  return NextResponse.redirect(target);
}

function decodeIdToken(idToken: string): MicrosoftIdTokenClaims | null {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
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

  if (providerError) {
    return loginError(
      req,
      providerError === "access_denied" ? "cancelled" : "provider_error",
    );
  }
  if (!code || !state) {
    return loginError(req, "invalid_callback");
  }

  const stateOk = await consumeOAuthStateCookie("microsoft", state);
  if (!stateOk) {
    return loginError(req, "state_mismatch");
  }

  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return loginError(req, "not_configured");
  }
  const redirectUri = buildCallbackUrl(req, "microsoft");

  let tokens: MicrosoftTokenResponse;
  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "openid email profile User.Read",
      }),
    });
    tokens = (await tokenRes.json()) as MicrosoftTokenResponse;
    if (!tokenRes.ok || tokens.error || !tokens.id_token) {
      console.error("[oauth/microsoft] token exchange failed:", tokens);
      return loginError(req, "token_exchange_failed");
    }
  } catch (e) {
    console.error("[oauth/microsoft] token exchange threw:", e);
    return loginError(req, "token_exchange_failed");
  }

  const claims = decodeIdToken(tokens.id_token);
  // Prefer the email claim when present; fall back to
  // preferred_username (the cross-account-type field).
  const rawEmail = (claims?.email ?? claims?.preferred_username ?? "").trim();
  if (!rawEmail || !rawEmail.includes("@")) {
    return loginError(req, "missing_email");
  }

  let resolvedUserId: string | null = null;
  let isNewUser = false;
  try {
    const result = await findOrCreateUserForOAuth({
      email: rawEmail,
      name: claims?.name ?? null,
      provider: "microsoft",
    });
    await issueOAuthSession({
      userId: result.userId,
      provider: "microsoft",
      req,
    });
    resolvedUserId = result.userId;
    isNewUser = result.isNewUser;
  } catch (e) {
    console.error("[oauth/microsoft] session mint failed:", e);
    return loginError(req, "session_mint_failed");
  }

  // Phase 17I-8 — profile enrichment via Microsoft Graph. The photo
  // endpoint /me/photo/$value requires Authorization with the access
  // token we just received; we pass it through so the server-side
  // fetcher can authenticate the one-shot download. Access token is
  // NEVER persisted; calendar OAuth (which DOES need long-lived
  // tokens) handles that in its own flow via encrypted storage.
  // Fire-and-forget — login latency unaffected by Graph latency.
  if (resolvedUserId && tokens.access_token) {
    void enrichUserProfileFromOAuth({
      userId: resolvedUserId,
      identity: {
        email: rawEmail,
        name: claims?.name ?? null,
        provider: "microsoft",
        pictureUrl: "https://graph.microsoft.com/v1.0/me/photo/$value",
        pictureBearerToken: tokens.access_token,
      },
    }).catch((e) => {
      console.warn("[oauth/microsoft] profile enrichment failed (non-fatal):", e);
    });
  }

  const nextCookie = req.cookies.get("zm_oauth_next")?.value;
  const nextPath = safeNextPath(nextCookie);

  // Phase GA4 — fire `signup_completed` only on net-new identities.
  // Returning logins are NOT a conversion, so we don't tag them.
  // GAProvider strips the params after firing, preserving clean URLs.
  const target = publicUrl(req, nextPath);
  if (isNewUser) {
    target.searchParams.set("ga_event", "signup_completed");
    target.searchParams.set("ga_provider", "microsoft");
  }
  const res = NextResponse.redirect(target);
  res.cookies.delete("zm_oauth_next");
  return res;
}
