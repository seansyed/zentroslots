/**
 * Granular permission flags layered ON TOP of the existing role enum.
 *
 * Strictly additive: existing requireRole(["admin"]) gates still work
 * unchanged. New sensitive features call `userHasPermission(user, flag)`
 * which:
 *   1. Looks up the role default (deny-by-default for new flags).
 *   2. Applies per-user overrides from users.permissions_extra jsonb.
 *
 * Per-user overrides exist so an operator can give exactly one staff
 * member `canViewAuditLogs` without promoting them to admin (or revoke
 * a flag from a manager without demoting them). Overrides are a flat
 * object: `{ canViewAuditLogs: true, canExportReports: false }`.
 *
 * Adding a new flag means:
 *   1. Add it to PERMISSION_FLAGS (closed union).
 *   2. Add it to ROLE_DEFAULTS for every role (always explicit — no
 *      implicit defaults).
 *   3. Gate the route with userHasPermission().
 *
 * NEVER reads from the DB. The User row is already loaded by
 * requireUser() callers; we just consult its `permissionsExtra` column.
 */

import type { Role, User } from "@/db/schema";

/** Closed enum of granular permission flags. Extend by adding to
 *  PERMISSION_FLAGS AND to every role row in ROLE_DEFAULTS. */
export const PERMISSION_FLAGS = [
  "canViewExecutiveAnalytics",
  "canManageAutomation",
  "canExportReports",
  "canManageSecurity",
  "canViewAuditLogs",
] as const;

export type PermissionFlag = (typeof PERMISSION_FLAGS)[number];

/** Default grants per role. Deny-by-default for any flag not listed.
 *  Every flag MUST appear in every role row — there is no implicit
 *  fallback. This forces an explicit decision when a new flag is added. */
export const ROLE_DEFAULTS: Record<Role, Record<PermissionFlag, boolean>> = {
  admin: {
    canViewExecutiveAnalytics: true,
    canManageAutomation: true,
    canExportReports: true,
    canManageSecurity: true,
    canViewAuditLogs: true,
  },
  manager: {
    canViewExecutiveAnalytics: true,
    canManageAutomation: true,
    canExportReports: true,
    // Managers can SEE security state but cannot revoke other users'
    // sessions or rotate keys. Bump to true via per-user override when
    // a manager doubles as a security lead.
    canManageSecurity: false,
    canViewAuditLogs: true,
  },
  staff: {
    canViewExecutiveAnalytics: false,
    canManageAutomation: false,
    canExportReports: false,
    canManageSecurity: false,
    canViewAuditLogs: false,
  },
  client: {
    canViewExecutiveAnalytics: false,
    canManageAutomation: false,
    canExportReports: false,
    canManageSecurity: false,
    canViewAuditLogs: false,
  },
};

/** Pure check — no DB. Pass the User row you already loaded. */
export function userHasPermission(user: User, flag: PermissionFlag): boolean {
  const extras = (user.permissionsExtra ?? {}) as Partial<Record<PermissionFlag, boolean>>;
  // Per-user override wins over role default (in BOTH directions —
  // overrides can grant OR revoke).
  if (Object.prototype.hasOwnProperty.call(extras, flag)) {
    return extras[flag] === true;
  }
  const defaults = ROLE_DEFAULTS[user.role];
  return defaults?.[flag] === true;
}

/** Resolve the effective permission map for a user — useful for the
 *  security dashboard's "this user can…" display. */
export function effectivePermissions(user: User): Record<PermissionFlag, boolean> {
  const out = {} as Record<PermissionFlag, boolean>;
  for (const flag of PERMISSION_FLAGS) {
    out[flag] = userHasPermission(user, flag);
  }
  return out;
}

/** Helper for API routes: throws 403 HttpError if the user lacks the
 *  flag. Use after requireUser() / requireRole(). */
export function requirePermission(user: User, flag: PermissionFlag): void {
  if (!userHasPermission(user, flag)) {
    // Lazy import to avoid pulling next/headers into pure consumers.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { HttpError } = require("@/lib/auth") as typeof import("@/lib/auth");
    throw new HttpError(403, "Forbidden");
  }
}
