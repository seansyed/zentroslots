/**
 * Client portal authentication.
 *
 * Clients don't have passwords. They sign in by entering the email they
 * booked with; we email them a short-lived signed link that, on click,
 * sets a `client_session` cookie scoped to (tenant, email, customer).
 *
 * Two JWT shapes both signed with JWT_SECRET, distinguished by
 * `purpose` so they can never be confused with tenant-admin sessions or
 * booking-action tokens:
 *
 *   purpose = "client_magiclink" → ~15 min, carries (email, tenantId)
 *   purpose = "client_session"   → ~30 days, carries (email, tenantId, customerId)
 */

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const MAGIC_LINK_EXPIRY = "15m";
const SESSION_EXPIRY = "30d";
const SESSION_COOKIE = "client_session";

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

export type ClientMagicLinkPayload = {
  email: string;
  tenantId: string;
};

export type ClientSessionPayload = {
  email: string;
  tenantId: string;
  customerId: string;
};

export async function signClientMagicLink(payload: ClientMagicLinkPayload): Promise<string> {
  return new SignJWT({ ...payload, purpose: "client_magiclink" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(MAGIC_LINK_EXPIRY)
    .sign(secret());
}

export async function verifyClientMagicLink(token: string): Promise<ClientMagicLinkPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.purpose !== "client_magiclink") return null;
    if (!payload.email || !payload.tenantId) return null;
    return {
      email: String(payload.email).toLowerCase(),
      tenantId: String(payload.tenantId),
    };
  } catch {
    return null;
  }
}

export async function signClientSession(payload: ClientSessionPayload): Promise<string> {
  return new SignJWT({ ...payload, purpose: "client_session" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(SESSION_EXPIRY)
    .sign(secret());
}

async function verifyClientSession(token: string): Promise<ClientSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.purpose !== "client_session") return null;
    if (!payload.email || !payload.tenantId || !payload.customerId) return null;
    return {
      email: String(payload.email).toLowerCase(),
      tenantId: String(payload.tenantId),
      customerId: String(payload.customerId),
    };
  } catch {
    return null;
  }
}

/**
 * Cookie helpers. Same Secure-flag dance as the admin session — opt out
 * via COOKIE_INSECURE=1 for plain-HTTP deploys.
 */
function cookieOpts() {
  const allowInsecure = process.env.COOKIE_INSECURE === "1";
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && !allowInsecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days, matches the JWT exp
  };
}

export async function setClientSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOpts());
}

export async function clearClientSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function getClientSession(): Promise<ClientSessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyClientSession(token);
}
