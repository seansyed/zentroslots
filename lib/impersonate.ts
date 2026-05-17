/**
 * Super-admin tenant impersonation.
 *
 * Model: the super-admin's existing session JWT is stashed in a separate
 * cookie (`scheduling_session_original`) and replaced by a fresh JWT for
 * the target tenant's admin user. The "exit" route swaps it back. This
 * keeps the regular auth code (auth.ts) unaware of impersonation — every
 * other route just sees a normal session for the target user.
 *
 * Why a separate cookie instead of an `imp` field on the JWT? Because
 * the JWT is read by countless places (lib/auth.ts, middlewares, route
 * handlers). Adding a field there leaks impersonation context into all
 * of them. Keeping it cookie-only means impersonation is invisible to
 * normal code paths.
 */

import { cookies } from "next/headers";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { createToken, HttpError, verifyToken } from "@/lib/auth";

const ORIGINAL_COOKIE = "scheduling_session_original";
const SESSION_COOKIE = "scheduling_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

function cookieOpts() {
  const allowInsecure = process.env.COOKIE_INSECURE === "1";
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && !allowInsecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  };
}

/**
 * Begin impersonating the target tenant. Picks the oldest admin in that
 * tenant — refuses if none exists (we deliberately don't impersonate
 * staff or client roles).
 */
export async function startImpersonation(
  superAdminToken: string,
  targetTenantId: string
): Promise<{ targetUserId: string; targetEmail: string }> {
  const target = await db.query.users.findFirst({
    where: and(eq(users.tenantId, targetTenantId), eq(users.role, "admin")),
    orderBy: asc(users.createdAt),
  });
  if (!target) {
    throw new HttpError(404, "Tenant has no admin user to impersonate");
  }

  const impToken = await createToken({
    sub: target.id,
    role: target.role,
    email: target.email,
    tenantId: target.tenantId,
  });

  const jar = await cookies();
  jar.set(ORIGINAL_COOKIE, superAdminToken, cookieOpts());
  jar.set(SESSION_COOKIE, impToken, cookieOpts());

  return { targetUserId: target.id, targetEmail: target.email };
}

/**
 * Restore the super-admin's original session. Returns the original
 * session payload (so the caller can audit-log the exit) — or null if
 * no impersonation was active.
 */
export async function exitImpersonation(): Promise<
  { originalEmail: string } | null
> {
  const jar = await cookies();
  const original = jar.get(ORIGINAL_COOKIE)?.value;
  if (!original) return null;

  const payload = await verifyToken(original);
  jar.set(SESSION_COOKIE, original, cookieOpts());
  jar.delete(ORIGINAL_COOKIE);

  return payload ? { originalEmail: payload.email } : { originalEmail: "?" };
}

/**
 * For UI: is this request being made under an active impersonation, and
 * if so, who's the underlying super-admin? Reads cookies only; cheap
 * enough to call from the banner component on every page.
 */
export async function getImpersonationState(): Promise<{
  active: boolean;
  originalEmail?: string;
  impersonatedEmail?: string;
}> {
  const jar = await cookies();
  const orig = jar.get(ORIGINAL_COOKIE)?.value;
  if (!orig) return { active: false };
  const [origPayload, sessPayload] = await Promise.all([
    verifyToken(orig),
    (async () => {
      const t = jar.get(SESSION_COOKIE)?.value;
      return t ? verifyToken(t) : null;
    })(),
  ]);
  return {
    active: true,
    originalEmail: origPayload?.email,
    impersonatedEmail: sessPayload?.email,
  };
}
