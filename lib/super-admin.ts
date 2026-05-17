/**
 * Super-admin = SaaS operator (you), not a workspace admin.
 * Authorization is by email allowlist via env var SUPER_ADMIN_EMAILS
 * (comma-separated). Keeps the concept zero-DB-cost.
 */

import { getSession } from "@/lib/auth";
import { HttpError } from "@/lib/auth";

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.SUPER_ADMIN_EMAILS;
  if (!raw) return false;
  const allow = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allow.includes(email.toLowerCase());
}

/**
 * Gate for super-admin API routes. Throws 404 (not 403) so a probing
 * attacker can't tell the route exists.
 */
export async function requireSuperAdmin(): Promise<{ email: string; sub: string }> {
  const session = await getSession();
  if (!session || !isSuperAdminEmail(session.email)) {
    throw new HttpError(404, "Not found");
  }
  return { email: session.email, sub: session.sub };
}
