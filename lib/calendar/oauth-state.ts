/**
 * Calendar-connect OAuth CSRF state (Wave: launch hardening).
 *
 * The calendar-connect flows (Google + Microsoft) historically used the
 * signed-in user's id as the OAuth `state` and only checked
 * `session.sub === state` in the callback. That binds the flow to the
 * session but provides NO CSRF protection: the user id is not secret, so
 * an attacker could initiate a flow and graft a code onto the victim's
 * session. This module mints an unguessable, single-use, cookie-bound
 * nonce instead — mirroring the proven sign-in flow in lib/auth/oauth.ts,
 * but under a SEPARATE cookie namespace (`zm_cal_state_*`) so a concurrent
 * sign-in and calendar-connect never stomp each other's cookie.
 *
 * The user/tenant association is unchanged: the callbacks already resolve
 * the user from the verified session, never from `state`.
 *
 * `generateCalendarOAuthState` and `calendarStateMatches` are pure (crypto
 * only) and unit-tested. The cookie read/write helpers use next/headers
 * and are server-only.
 */
import crypto from "crypto";
import { cookies } from "next/headers";

export type CalendarOAuthProvider = "google" | "microsoft";

const CAL_STATE_COOKIE_PREFIX = "zm_cal_state_";
const CAL_STATE_TTL_SECONDS = 600; // 10 minutes — well above a normal consent round-trip
const STATE_BYTES = 32;

/** Cookie name for a provider's calendar-connect state nonce. */
export function calStateCookieName(provider: CalendarOAuthProvider): string {
  return CAL_STATE_COOKIE_PREFIX + provider;
}

/** Generate a 32-byte URL-safe random state token. */
export function generateCalendarOAuthState(): string {
  return crypto.randomBytes(STATE_BYTES).toString("base64url");
}

/**
 * Constant-time equality of the stored vs presented state. Pure +
 * unit-testable. Returns false on any missing value or length mismatch.
 */
export function calendarStateMatches(
  stored: string | null | undefined,
  presented: string | null | undefined,
): boolean {
  if (!stored || !presented) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Persist the state in a short-lived httpOnly cookie (single OAuth flow). */
export async function setCalendarStateCookie(
  provider: CalendarOAuthProvider,
  state: string,
): Promise<void> {
  const jar = await cookies();
  jar.set(calStateCookieName(provider), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // Lax: sent on the top-level GET redirect back from the provider
    path: "/",
    maxAge: CAL_STATE_TTL_SECONDS,
  });
}

/**
 * Read + DELETE (single-use) the state cookie and compare it to the
 * presented value in constant time. Always deletes the cookie, even on
 * failure, so a state value can never be replayed.
 */
export async function consumeCalendarStateCookie(
  provider: CalendarOAuthProvider,
  presented: string | null | undefined,
): Promise<boolean> {
  const jar = await cookies();
  const name = calStateCookieName(provider);
  const stored = jar.get(name)?.value ?? null;
  jar.delete(name); // single-use regardless of match result
  return calendarStateMatches(stored, presented);
}
