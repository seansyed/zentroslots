/**
 * Mobile calendar-OAuth handoff (secure, stateless).
 *
 * The web calendar-connect flow authenticates the OAuth callback via an
 * httpOnly session cookie + a CSRF state cookie. The mobile system browser
 * has NEITHER (the app authenticates with a Bearer JWT that the browser
 * can't see). So mobile needs a different, equally-safe binding.
 *
 * Design:
 *   1. The app (Bearer-authed) hits /api/calendar/{provider}/connect/mobile.
 *      That endpoint mints a SHORT-LIVED, SIGNED state token (HS256, 10min)
 *      that binds { userId, tenantId, provider, purpose }. It returns the
 *      provider authorization URL carrying that state.
 *   2. The app opens the URL in the system browser (WebBrowser).
 *   3. The provider redirects to the EXISTING HTTPS callback
 *      /api/calendar/{provider}/callback?code=…&state=<signed token>.
 *   4. The callback verifies the signed state (no cookie, no getSession),
 *      resolves the user/tenant from it, exchanges the code, and persists
 *      the encrypted tokens server-side via the SAME upsert the web flow
 *      uses. It then deep-links zentromeet://oauth/calendar/{provider}/
 *      success — carrying NO tokens, only a success/error signal.
 *
 * Security properties:
 *   • Provider access/refresh tokens never touch the device or any URL —
 *     they go straight into calendar_connections (AES-GCM at rest).
 *   • The state is signed (tamper-proof) + short-lived (10min) + bound to
 *     the exact user/tenant/provider, so it can't be replayed to attach a
 *     connection to a different account. JWT_SECRET signs it (same secret
 *     as sessions; never shipped to the client).
 *   • Web flow is untouched: web callbacks still use the cookie-state path;
 *     this signed-state path is only taken when verifyCalendarMobileState
 *     succeeds (web's random cookie nonce is not a valid JWT).
 */

import { SignJWT, jwtVerify } from "jose";

export type CalendarOAuthProvider = "google" | "microsoft";

const PURPOSE = "cal_mobile_connect";
const STATE_TTL = "10m";
const SCHEME = "zentromeet";

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

/** Mint a signed, short-lived state token binding the connecting user. */
export async function mintCalendarMobileState(args: {
  userId: string;
  tenantId: string;
  provider: CalendarOAuthProvider;
}): Promise<string> {
  return new SignJWT({
    tenantId: args.tenantId,
    provider: args.provider,
    purpose: PURPOSE,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(args.userId)
    .setIssuedAt()
    .setExpirationTime(STATE_TTL)
    .sign(secret());
}

/**
 * Verify a callback `state` as a mobile calendar token. Returns the bound
 * user/tenant when valid for THIS provider, else null (so the caller falls
 * through to the web cookie-state path). Never throws.
 */
export async function verifyCalendarMobileState(
  state: string | null | undefined,
  provider: CalendarOAuthProvider,
): Promise<{ userId: string; tenantId: string } | null> {
  if (!state) return null;
  try {
    const { payload } = await jwtVerify(state, secret());
    if (payload.purpose !== PURPOSE) return null;
    if (payload.provider !== provider) return null;
    if (!payload.sub || !payload.tenantId) return null;
    return { userId: String(payload.sub), tenantId: String(payload.tenantId) };
  } catch {
    return null;
  }
}

/** Deep link signalling a successful connection (NO tokens in the URL). */
export function buildCalendarMobileSuccessUrl(provider: CalendarOAuthProvider): string {
  return `${SCHEME}://oauth/calendar/${provider}/success`;
}

/** Deep link signalling a failed/cancelled connection. */
export function buildCalendarMobileErrorUrl(
  provider: CalendarOAuthProvider,
  code: string,
): string {
  const safe = encodeURIComponent(code.slice(0, 80));
  return `${SCHEME}://oauth/calendar/${provider}/error?error=${safe}`;
}
