/**
 * HMAC tokens for waitlist claim links.
 *
 * Separate `purpose: waitlist_claim` claim from booking-action tokens
 * so a claim token can never be mistaken for a cancel/reschedule
 * token (and vice versa). Uses the same JWT_SECRET; expiry matches
 * the reservation window we set on the row.
 */
import { SignJWT, jwtVerify } from "jose";

export type WaitlistClaimTokenPayload = {
  notificationId: string;
  waitlistId: string;
  tenantId: string;
};

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

/**
 * Sign a claim token whose exp matches the reservation expiry. The
 * server-side check ALSO validates the row's expires_at — token-only
 * expiry isn't enough (an admin may manually expire a hold).
 */
export async function signWaitlistClaimToken(
  payload: WaitlistClaimTokenPayload,
  expiresAt: Date
): Promise<string> {
  return new SignJWT({ ...payload, purpose: "waitlist_claim" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret());
}

export async function verifyWaitlistClaimToken(
  token: string
): Promise<WaitlistClaimTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.purpose !== "waitlist_claim") return null;
    if (!payload.notificationId || !payload.waitlistId || !payload.tenantId) return null;
    return {
      notificationId: String(payload.notificationId),
      waitlistId: String(payload.waitlistId),
      tenantId: String(payload.tenantId),
    };
  } catch {
    return null;
  }
}

export function buildClaimUrl(token: string): string {
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  return `${base}/waitlist/claim/${encodeURIComponent(token)}`;
}
