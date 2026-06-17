import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { db } from "@/db/client";
import { eq, lt } from "drizzle-orm";
import { revokedSessionJtis, users, type Role, type User } from "@/db/schema";

const COOKIE_NAME = "scheduling_session";
const TOKEN_EXPIRY = "7d";
const TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60_000;

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
  /** JWT id — present on tokens issued after security migration 0028.
   *  Legacy tokens (issued before) omit this; verifyToken treats them
   *  as unrevokable-per-session but still subject to session_min_iat
   *  bulk revocation. */
  jti?: string;
  /** Issued-at (seconds since epoch). Populated by jose automatically
   *  via setIssuedAt(); we expose it in the typed payload so
   *  verifySessionFresh() can compare against users.sessionMinIat. */
  iat?: number;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Create a new session JWT. Returns the signed string (legacy
 *  signature). Every token still gets a jti so it can be individually
 *  revoked — callers that want to record the jti (e.g. login route
 *  writing a session_audit_event) should use createTokenWithJti
 *  instead. */
export async function createToken(payload: SessionPayload): Promise<string> {
  const { token } = await createTokenWithJti(payload);
  return token;
}

/** Same as createToken but also returns the embedded jti so the
 *  caller can record it in session_audit_events / link it to a later
 *  revoke. */
export async function createTokenWithJti(payload: SessionPayload): Promise<{ token: string; jti: string }> {
  const jti = payload.jti ?? crypto.randomBytes(16).toString("base64url");
  const token = await new SignJWT({ ...payload, jti })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(jti)
    .setExpirationTime(TOKEN_EXPIRY)
    .sign(secret());
  return { token, jti };
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
      jti: payload.jti ? String(payload.jti) : undefined,
      iat: typeof payload.iat === "number" ? payload.iat : undefined,
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
  let token = jar.get(COOKIE_NAME)?.value;
  if (!token) {
    // Mobile clients have no cookie jar — they authenticate by sending the
    // SAME signed session JWT as `Authorization: Bearer <token>`. Accept it
    // here so a single getSession()/requireUser() path serves both web
    // (httpOnly cookie) and mobile (Bearer). The token is verified
    // identically (signature + expiry via verifyToken), so this adds no new
    // trust surface, and Bearer is CSRF-safe (not auto-sent by browsers).
    token = bearerToken(await headers());
  }
  if (!token) return null;
  return verifyToken(token);
}

/** Extract a Bearer token from an Authorization header, if present.
 *  Accepts any header bag with a `get()` (Headers, ReadonlyHeaders, or a
 *  NextRequest's headers). */
function bearerToken(h: { get(name: string): string | null }): string | undefined {
  const authz = h.get("authorization");
  if (authz && authz.toLowerCase().startsWith("bearer ")) {
    const t = authz.slice(7).trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
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
 * "Managerial" = can see workspace-wide data (all bookings, all staff
 * records, full reports) but is NOT necessarily allowed to touch billing
 * or tenant settings. Use this for visibility/scoping checks. Use
 * requireRole(["admin"]) for hard admin-only routes.
 */
export function isManagerial(role: Role): boolean {
  return role === "admin" || role === "manager";
}

/**
 * Is a POST /api/bookings call an INTERNAL operator create (vs. a public
 * customer self-checkout)?
 *
 * True only when there is a valid TENANT-USER session whose tenant matches the
 * service's tenant — i.e. a logged-in staff/admin/manager (the mobile operator
 * app, or a logged-in dashboard user) booking within their own workspace.
 *
 * This is SERVER-DERIVED authority: the public booking page is unauthenticated,
 * so anonymous customers always get `false` (and keep the payment-hold/checkout
 * path). It deliberately takes only the verified session + the service's tenant
 * id — NEVER a client-supplied flag — so an internal booking cannot be spoofed.
 *
 * Internal operator bookings must skip the `pending_payment` hold path; payment
 * (if any) is collected out-of-band, mirroring POST /api/tenant/appointments'
 * skipPayment semantics. This prevents the holds:expire cron from auto-cancelling
 * operator-created appointments.
 */
export function isInternalOperatorBooking(
  session: Pick<SessionPayload, "tenantId" | "role"> | null,
  serviceTenantId: string,
): boolean {
  if (!session || session.tenantId !== serviceTenantId) return false;
  // ONLY tenant STAFF roles are operators. The external "client" role
  // (roleEnum: "booking only") must NOT bypass the payment hold even when
  // logged in — that would be a payment-integrity hole (a customer self-
  // confirming a paid booking without paying).
  return session.role === "admin" || session.role === "manager" || session.role === "staff";
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
  // Cookie (web) first, then Authorization: Bearer (mobile) — same JWT shape.
  const token = req.cookies.get(COOKIE_NAME)?.value ?? bearerToken(req.headers);
  if (!token) return null;
  return verifyToken(token);
}

// ─── Session freshness + revocation (security hardening 0028) ─────────
// These helpers are OPT-IN. The booking engine + most routes still use
// the cheap stateless getSession() — perf unchanged. Security-sensitive
// flows (security dashboard, password change, billing settings, role
// changes) should additionally call verifySessionFresh() which:
//   1. Verifies the JWT signature + expiry (same as getSession).
//   2. Rejects if the token's jti is in revoked_session_jtis (per-session
//      revoke). Cached in-process for 30s to keep the DB cost negligible.
//   3. Rejects if the user's sessionMinIat is later than the token's iat
//      (bulk revoke = "revoke all sessions").
// Tokens issued before 0028 lack a jti and are unrevokable per-session,
// but still subject to the bulk-revoke path via sessionMinIat.

type RevokeCacheEntry = { revokedAt: number; cachedAt: number };
const REVOKE_CACHE_TTL_MS = 30_000;
const revokeCache = new Map<string, RevokeCacheEntry | null>();

async function isJtiRevoked(jti: string): Promise<boolean> {
  const now = Date.now();
  const cached = revokeCache.get(jti);
  if (cached !== undefined && cached !== null && now - cached.cachedAt < REVOKE_CACHE_TTL_MS) {
    return true;
  }
  if (cached === null && cached !== undefined) {
    // Was explicitly cached as not-revoked; trust it within TTL window.
    // (We don't store the not-revoked timestamp; the Map miss path
    // re-checks each call. This is the conservative-cost branch.)
  }
  try {
    const row = await db.query.revokedSessionJtis.findFirst({
      where: eq(revokedSessionJtis.jti, jti),
    });
    if (row) {
      revokeCache.set(jti, { revokedAt: row.revokedAt.getTime(), cachedAt: now });
      return true;
    }
    return false;
  } catch (err) {
    // Defensive: if the denylist check fails (DB blip), DO NOT lock
    // the user out — log and return false. The session_min_iat bulk
    // check still applies via the verifySessionFresh path.
    console.error("[auth] isJtiRevoked check failed:", err);
    return false;
  }
}

export type FreshSessionResult =
  | { ok: true; payload: SessionPayload; user: User }
  | { ok: false; reason: "no_session" | "revoked" | "bulk_revoked" | "user_missing" };

/** Strict session validation. Checks:
 *    - JWT signature + expiry (via verifyToken)
 *    - jti revocation denylist
 *    - per-user bulk-revoke timestamp (users.sessionMinIat)
 *    - user row still exists
 *
 *  Returns a typed result. Use this for ANY route that performs a
 *  security-sensitive action: security settings, password change,
 *  granting permissions, billing changes, exports. Booking + read
 *  flows can continue using the cheaper getSession(). */
export async function verifySessionFresh(): Promise<FreshSessionResult> {
  const payload = await getSession();
  if (!payload) return { ok: false, reason: "no_session" };

  // Per-session revoke.
  if (payload.jti && (await isJtiRevoked(payload.jti))) {
    return { ok: false, reason: "revoked" };
  }

  // Load the user once — also surfaces if the account was deleted.
  const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });
  if (!user) return { ok: false, reason: "user_missing" };

  // Bulk-revoke: token issued BEFORE the user's sessionMinIat is rejected.
  if (user.sessionMinIat && payload.iat) {
    const tokenIatMs = payload.iat * 1000;
    if (tokenIatMs < user.sessionMinIat.getTime()) {
      return { ok: false, reason: "bulk_revoked" };
    }
  }

  return { ok: true, payload, user };
}

/** Revoke a single session by its jti. Used by the security dashboard's
 *  "sign out this device" action. Idempotent — replays are safe. */
export async function revokeSessionJti(args: {
  jti: string;
  userId?: string | null;
  reason?: string;
}): Promise<void> {
  // Expiry of the original token = now + remaining lifetime, but we
  // don't know the original iat without re-decoding. Use the maximum
  // possible expiry (now + TOKEN_LIFETIME_MS) so the pruner doesn't
  // prematurely drop the denylist row while the underlying JWT is
  // still potentially valid.
  const tokenExpiresAt = new Date(Date.now() + TOKEN_LIFETIME_MS);
  try {
    await db
      .insert(revokedSessionJtis)
      .values({
        jti: args.jti,
        userId: args.userId ?? null,
        tokenExpiresAt,
        reason: args.reason ?? null,
      })
      .onConflictDoNothing({ target: revokedSessionJtis.jti });
    // Eagerly cache so the next request to verifySessionFresh sees
    // the revocation without a DB round-trip.
    revokeCache.set(args.jti, { revokedAt: Date.now(), cachedAt: Date.now() });
  } catch (err) {
    console.error("[auth] revokeSessionJti failed:", err);
  }
}

/** Bulk-revoke every session for a user. Bumps users.sessionMinIat to
 *  the current second — every JWT issued before that is rejected on
 *  next verifySessionFresh. Effective immediately for ALL existing
 *  tokens (including legacy ones without jti). */
export async function revokeAllSessionsForUser(userId: string): Promise<void> {
  try {
    await db
      .update(users)
      .set({ sessionMinIat: new Date() })
      .where(eq(users.id, userId));
  } catch (err) {
    console.error("[auth] revokeAllSessionsForUser failed:", err);
  }
}

/** Cron-friendly: prune denylist rows whose underlying token has
 *  expired anyway. Keeps the table small. */
export async function pruneRevokedJtis(): Promise<number> {
  try {
    const r = await db
      .delete(revokedSessionJtis)
      .where(lt(revokedSessionJtis.tokenExpiresAt, new Date()))
      .returning({ jti: revokedSessionJtis.jti });
    return r.length;
  } catch (err) {
    console.error("[auth] pruneRevokedJtis failed:", err);
    return 0;
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) {
    // Intentional, operator-authored status + message — safe to surface
    // to the UI as-is (e.g. "Slot just taken — pick another").
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  // Map ZodError → 400 with field-level details. Duck-typed so we don't
  // need to import zod in this file. These messages are schema-authored
  // (field names + constraints), not raw runtime exceptions.
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
  // Unexpected error. We MUST NOT surface err.message to the client — it
  // can contain Node/TypeScript/SQL/driver internals, stack fragments, or
  // sensitive values. This is the P0 that leaked a raw Node TypeError
  // ("...Received an instance of Date") into the New Appointment UI.
  //
  // Contract: the RAW error stays in the server logs (stdout → PM2),
  // tagged with a short correlation id so support can find it; the CLIENT
  // only ever gets a fixed, friendly message + a stable `code` it can map
  // to screen-specific copy, plus the incidentId for support reference.
  const incidentId = crypto.randomUUID().slice(0, 8);
  console.error(`API error [${incidentId}]:`, err);
  return NextResponse.json(
    {
      error:
        "Something went wrong. Please try again, or contact support if the problem continues.",
      code: "internal_error",
      incidentId,
    },
    { status: 500 }
  );
}
