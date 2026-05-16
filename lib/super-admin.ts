/**
 * Super-admin = SaaS operator (you), not a workspace admin.
 * Authorization is by email allowlist via env var SUPER_ADMIN_EMAILS
 * (comma-separated). Keeps the concept zero-DB-cost.
 */

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.SUPER_ADMIN_EMAILS;
  if (!raw) return false;
  const allow = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allow.includes(email.toLowerCase());
}
