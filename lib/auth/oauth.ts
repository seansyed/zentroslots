/**
 * OAuth login helpers (Phase 17I-7).
 *
 * Implements "Continue with Google" + "Continue with Microsoft" on top
 * of the EXISTING custom-JWT auth system. NEVER rewrites session
 * architecture, NEVER touches the calendar OAuth flow.
 *
 * Architecture:
 *   • Each provider has start + callback endpoints (app/api/auth/oauth/
 *     {google,microsoft}/{start,callback}/route.ts) that delegate
 *     identity lookup + session minting to these helpers.
 *   • State (CSRF) is a 32-byte random value stored both in the URL
 *     state param AND a short-lived httpOnly cookie; mismatch =
 *     reject. Cookie name namespaced per provider.
 *   • Account linking is by VERIFIED email. If a user row already
 *     exists for that email in any tenant, log them in. If not, mint
 *     a new admin workspace (mirrors the existing signup flow's
 *     admin-default behavior) so OAuth signup works end-to-end.
 *   • OAuth-only users get a random 32-byte placeholder password hash
 *     so the existing NOT NULL constraint is preserved without a
 *     schema change. They can set a real password later via
 *     /forgot-password.
 *   • Calendar OAuth + auth OAuth share the OAuth CLIENT credentials
 *     (env vars) but request DIFFERENT scopes through DIFFERENT
 *     redirect URIs. Token storage is fully separated — auth tokens
 *     never persist; calendar tokens live in calendar_connections.
 */

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenants, users } from "@/db/schema";
import {
  createTokenWithJti,
  hashPassword,
  setSessionCookie,
} from "@/lib/auth";
import { generateUniqueSlug } from "@/lib/tenant";
import { audit, ipFromHeaders } from "@/lib/audit";
import { recordSessionEvent, userAgentFromHeaders } from "@/lib/security/sessionEvents";
import { deviceLabelFor } from "@/lib/security/heuristics";

export type OAuthProvider = "google" | "microsoft";

const STATE_COOKIE_PREFIX = "zm_oauth_state_";
const STATE_COOKIE_TTL_SECONDS = 600; // 10 minutes
const STATE_BYTES = 32;

// ─── State / CSRF ──────────────────────────────────────────────────────

/** Generate a 32-byte URL-safe random state token. */
export function generateOAuthState(): string {
  return crypto.randomBytes(STATE_BYTES).toString("base64url");
}

/** Persist the state value in a short-lived httpOnly cookie so the
 *  callback can verify it. Namespaced per provider so concurrent flows
 *  on two providers don't stomp each other. */
export async function setOAuthStateCookie(
  provider: OAuthProvider,
  state: string,
): Promise<void> {
  const jar = await cookies();
  jar.set(STATE_COOKIE_PREFIX + provider, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STATE_COOKIE_TTL_SECONDS,
  });
}

/** Read + delete the state cookie. Returns null if missing OR if the
 *  cookie value doesn't match the URL-supplied state. */
export async function consumeOAuthStateCookie(
  provider: OAuthProvider,
  presented: string,
): Promise<boolean> {
  const jar = await cookies();
  const name = STATE_COOKIE_PREFIX + provider;
  const stored = jar.get(name)?.value ?? null;
  jar.delete(name); // single-use, regardless of result
  if (!stored || !presented) return false;
  // Constant-time equality to avoid timing leaks.
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── Redirect URI construction ─────────────────────────────────────────

/** Build the absolute callback URL using the incoming request's host
 *  (honors x-forwarded-host + x-forwarded-proto so it works behind the
 *  Caddy/nginx reverse proxy fronting app.zentromeet.com). */
export function buildCallbackUrl(req: NextRequest, provider: OAuthProvider): string {
  const h = req.headers;
  const fwdHost = h.get("x-forwarded-host");
  const fwdProto = h.get("x-forwarded-proto");
  const host = (fwdHost ?? h.get("host") ?? "app.zentromeet.com").trim();
  const proto = (fwdProto ?? "https").trim();
  return `${proto}://${host}/api/auth/oauth/${provider}/callback`;
}

// ─── Identity → session ────────────────────────────────────────────────

export type OAuthIdentity = {
  /** Verified email (lowercased before reaching here). */
  email: string;
  /** Display name from the provider. Falls back to the email local-
   *  part when blank. */
  name: string | null;
  provider: OAuthProvider;
};

export type OAuthLoginResult = {
  userId: string;
  tenantId: string;
  /** true when this call created a brand-new user (+ workspace) */
  isNewUser: boolean;
};

/**
 * Find an existing user by verified email OR create a new admin
 * workspace for them. Mirrors the email-lookup semantics of the
 * existing password-login route (findFirst → first tenant match).
 *
 * For new users we mint a tenant the same way the signup route does:
 * `{Name}'s workspace` with an auto-generated unique slug. The user
 * lands as admin of that tenant.
 *
 * Existing-user case is safe + idempotent: we just look up the row
 * and reuse it. We NEVER touch the password_hash on existing rows,
 * so a user who has a password set keeps the ability to log in with
 * password OR Google OR Microsoft (account linking by email).
 */
export async function findOrCreateUserForOAuth(
  identity: OAuthIdentity,
): Promise<OAuthLoginResult> {
  const email = identity.email.toLowerCase().trim();
  if (!email) {
    throw new Error("oauth: identity has no email");
  }

  // Mirror the password-login lookup: first match across tenants.
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existing) {
    return {
      userId: existing.id,
      tenantId: existing.tenantId,
      isNewUser: false,
    };
  }

  // Brand-new user → mint a workspace + admin user. Mirrors the
  // signup route's admin path (which itself defaults to
  // "{Name}'s workspace" when workspaceName is blank).
  const displayName =
    identity.name && identity.name.trim().length > 0
      ? identity.name.trim()
      : email.split("@")[0];
  const workspaceName = `${displayName}'s workspace`;
  const slug = await generateUniqueSlug(workspaceName);

  // Random placeholder password hash so the NOT NULL constraint on
  // users.password_hash is preserved without a schema change. The
  // bcrypt of 32 random bytes is computationally impossible to
  // recover; the user must use /forgot-password to set a real one
  // (or just keep using OAuth — that's the typical path).
  const randomPlaceholder = crypto.randomBytes(32).toString("base64url");
  const placeholderHash = await hashPassword(randomPlaceholder);

  const [tenant] = await db
    .insert(tenants)
    .values({ name: workspaceName, slug, plan: "free", active: true })
    .returning();

  const [user] = await db
    .insert(users)
    .values({
      tenantId: tenant.id,
      email,
      passwordHash: placeholderHash,
      name: displayName,
      role: "admin",
      timezone: "UTC", // matches signup default; user can edit later
    })
    .returning();

  audit({
    tenantId: tenant.id,
    action: "auth.oauth_signup",
    actorUserId: user.id,
    actorLabel: user.name,
    metadata: { provider: identity.provider },
  });

  return {
    userId: user.id,
    tenantId: tenant.id,
    isNewUser: true,
  };
}

/**
 * Issue a session for the resolved user. Reuses the EXACT same
 * createTokenWithJti + setSessionCookie path the password-login
 * route uses — same cookie name, same JWT shape, same expiry, same
 * jti revocation surface. Also records a session_audit_events row
 * tagged with the OAuth provider so the security dashboard can
 * distinguish password vs OAuth logins.
 */
export async function issueOAuthSession(args: {
  userId: string;
  provider: OAuthProvider;
  req: NextRequest;
}): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, args.userId) });
  if (!user) throw new Error("oauth: user vanished between lookup and session mint");

  const { token, jti } = await createTokenWithJti({
    sub: user.id,
    role: user.role,
    email: user.email,
    tenantId: user.tenantId,
  });
  await setSessionCookie(token);

  // Update last-login fingerprint to match the password-login route.
  const ip = ipFromHeaders(args.req.headers);
  const userAgent = userAgentFromHeaders(args.req.headers);
  try {
    await db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        lastLoginIp: ip,
        lastLoginUserAgent: userAgent,
      })
      .where(eq(users.id, user.id));
  } catch (e) {
    console.error("[oauth] last-login bookkeeping failed:", e);
  }

  await recordSessionEvent({
    tenantId: user.tenantId,
    userId: user.id,
    eventType: "login",
    sessionJti: jti,
    ipAddress: ip,
    userAgent,
    deviceLabel: deviceLabelFor(userAgent),
    metadata: { provider: args.provider, method: "oauth" },
  });

  audit({
    tenantId: user.tenantId,
    action: "auth.login",
    actorUserId: user.id,
    actorLabel: user.name,
    ipAddress: ip,
    metadata: { provider: args.provider, method: "oauth" },
  });
}

// ─── Post-callback safety net ──────────────────────────────────────────

/** Ensure the post-callback redirect target stays within the app —
 *  never honor an attacker-controlled absolute URL. Used by callers
 *  that respect a `?next=` query param. */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/dashboard";
  // Only same-origin paths starting with a single `/` (not `//`).
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

// Re-export the and/eq imports so callers don't need their own drizzle
// imports for typical OAuth flows. (Kept commented out — clean tree
// shake when the helpers below aren't used by a given route.)
export { and, eq };
