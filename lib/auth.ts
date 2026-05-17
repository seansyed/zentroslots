import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { eq } from "drizzle-orm";
import { users, type Role, type User } from "@/db/schema";

const COOKIE_NAME = "scheduling_session";
const TOKEN_EXPIRY = "7d";

function secret(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(s);
}

export type SessionPayload = {
  sub: string;       // user id
  role: Role;
  email: string;
  tenantId: string;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(secret());
}

export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.tenantId) return null; // legacy token without tenant — reject
    return {
      sub: String(payload.sub),
      role: payload.role as Role,
      email: String(payload.email),
      tenantId: String(payload.tenantId),
    };
  } catch {
    return null;
  }
}

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  // `Secure` is mandatory under HTTPS but breaks plain-HTTP deployments
  // (browsers silently drop the cookie). Allow ops to opt out *only* if
  // they explicitly set COOKIE_INSECURE=1 — never default to off.
  const allowInsecure = process.env.COOKIE_INSECURE === "1";
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && !allowInsecure,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyToken(token);
}

export async function requireUser(): Promise<User> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Unauthorized");
  const user = await db.query.users.findFirst({ where: eq(users.id, session.sub) });
  if (!user) throw new HttpError(401, "Unauthorized");
  return user;
}

export async function requireRole(roles: Role[]): Promise<User> {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new HttpError(403, "Forbidden");
  return user;
}

/**
 * Cheap (cookie-only) read of the current tenant id, when a route
 * needs the tenant scope but doesn't otherwise need the full user row.
 * For anything that mutates state, prefer requireUser() so a deleted
 * user can't still hold a valid cookie.
 */
export async function getTenantId(): Promise<string | null> {
  const session = await getSession();
  return session?.tenantId ?? null;
}

// Edge-friendly session read for route handlers that already hold a NextRequest.
export async function getSessionFromRequest(req: NextRequest): Promise<SessionPayload | null> {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return verifyToken(token);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  // Map ZodError → 400 with field-level details. Duck-typed so we don't
  // need to import zod in this file.
  if (
    err &&
    typeof err === "object" &&
    (err as { name?: string }).name === "ZodError" &&
    Array.isArray((err as { issues?: unknown[] }).issues)
  ) {
    return NextResponse.json(
      { error: "Invalid input", issues: (err as { issues: unknown[] }).issues },
      { status: 400 }
    );
  }
  console.error("API error:", err);
  const message = err instanceof Error ? err.message : "Internal error";
  return NextResponse.json({ error: message }, { status: 500 });
}
