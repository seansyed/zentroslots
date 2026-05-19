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

// ─── Phase 2: backward-compatible enforcement wrappers ─────────────────
// These compose with existing requireRole() callers without altering
// their behavior. The migration story:
//
//   BEFORE (legacy, still works):
//     const user = await requireRole(["admin", "manager"]);
//
//   AFTER (granular, additive):
//     const user = await requirePermissionOrRole({
//       allowRoles: ["admin", "manager"],   // legacy fallback
//       requirePermission: "canExportReports",
//     });
//
// The wrapper passes EITHER the legacy role check (back-compat for
// admins / managers who already had access) OR the new flag (so a
// staff member with an override can also pass). Admins keep access
// automatically because ROLE_DEFAULTS.admin grants every flag.
//
// Every denial emits a structured `security.permission.denied` audit
// row + stdout JSON line so ops can see WHICH gate fired and where.
// Audit emission is throttled in-process per (userId, flag, path) to
// avoid log flooding when the UI retries.

export type EnforcementOptions = {
  /** Legacy role allowlist — passes the check independent of the
   *  granular flag (back-compat). Omit to require the flag only. */
  allowRoles?: Role[];
  /** Granular permission flag the caller may use. */
  requirePermission?: PermissionFlag;
  /** Multiple flags — caller must have AT LEAST ONE. Mutually
   *  exclusive with requireAllPermissions and requirePermission. */
  requireAnyPermission?: PermissionFlag[];
  /** Multiple flags — caller must have ALL. Mutually exclusive with
   *  the above two. */
  requireAllPermissions?: PermissionFlag[];
  /** Optional path for audit-log context ("/api/tenant/automations"). */
  auditPath?: string;
};

/** Returns the authenticated user when the check passes; throws 403
 *  HttpError otherwise. Internally calls requireUser() so a deleted
 *  user with a still-valid cookie is rejected as 401, identical to
 *  the legacy requireRole() behavior. */
export async function requirePermissionOrRole(opts: EnforcementOptions): Promise<User> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { requireUser, HttpError } = require("@/lib/auth") as typeof import("@/lib/auth");
  const user = await requireUser();

  if (passes(user, opts)) return user;

  // Denial: emit audit + throw. Recorded with the missing flag list so
  // a dashboard can show "needs canExportReports".
  await emitDeniedAudit(user, opts);
  throw new HttpError(403, "Forbidden");
}

/** Convenience wrapper: caller must have AT LEAST ONE flag (and may
 *  also pass via allowRoles). */
export async function requireAnyPermission(
  flags: PermissionFlag[],
  opts?: { allowRoles?: Role[]; auditPath?: string }
): Promise<User> {
  return requirePermissionOrRole({
    allowRoles: opts?.allowRoles,
    requireAnyPermission: flags,
    auditPath: opts?.auditPath,
  });
}

/** Convenience wrapper: caller must have EVERY flag. allowRoles is
 *  evaluated FIRST — an admin in the allowlist passes regardless of
 *  flag presence (because every admin defaults to true on every flag
 *  anyway, but explicit is safer if an override revokes a flag from
 *  an admin). */
export async function requireAllPermissions(
  flags: PermissionFlag[],
  opts?: { allowRoles?: Role[]; auditPath?: string }
): Promise<User> {
  return requirePermissionOrRole({
    allowRoles: opts?.allowRoles,
    requireAllPermissions: flags,
    auditPath: opts?.auditPath,
  });
}

// ─── Internals ────────────────────────────────────────────────────────

function passes(user: User, opts: EnforcementOptions): boolean {
  // Role allowlist — legacy back-compat path. We honor a role match
  // even if the user has a per-user override REVOKING the flag, because
  // the explicit allowRoles is the operator saying "trust this role
  // for this endpoint." If you want override-revoke to win, omit
  // allowRoles entirely.
  if (opts.allowRoles && opts.allowRoles.includes(user.role)) {
    return true;
  }

  if (opts.requirePermission) {
    if (userHasPermission(user, opts.requirePermission)) return true;
  }

  if (opts.requireAnyPermission && opts.requireAnyPermission.length > 0) {
    if (opts.requireAnyPermission.some((f) => userHasPermission(user, f))) return true;
  }

  if (opts.requireAllPermissions && opts.requireAllPermissions.length > 0) {
    if (opts.requireAllPermissions.every((f) => userHasPermission(user, f))) return true;
  }

  return false;
}

/** Determine which flags the user was missing — used in the denial
 *  audit payload so dashboards / alerting can show actionable context. */
function missingFlags(user: User, opts: EnforcementOptions): PermissionFlag[] {
  const out: PermissionFlag[] = [];
  if (opts.requirePermission && !userHasPermission(user, opts.requirePermission)) {
    out.push(opts.requirePermission);
  }
  if (opts.requireAnyPermission) {
    if (!opts.requireAnyPermission.some((f) => userHasPermission(user, f))) {
      out.push(...opts.requireAnyPermission);
    }
  }
  if (opts.requireAllPermissions) {
    for (const f of opts.requireAllPermissions) {
      if (!userHasPermission(user, f)) out.push(f);
    }
  }
  return Array.from(new Set(out));
}

// ── Throttle denial audits per (user, flag-set, path) ─────────────
// 60-second window keeps the noisy "user keeps clicking the disabled
// button" case from spamming audit_logs while still surfacing each
// distinct (user × endpoint × required-flag) once a minute.
const denyAuditCache = new Map<string, number>();
const DENY_AUDIT_TTL_MS = 60_000;

async function emitDeniedAudit(user: User, opts: EnforcementOptions): Promise<void> {
  try {
    const missing = missingFlags(user, opts);
    const path = opts.auditPath ?? "(unspecified)";
    const cacheKey = `${user.id}|${path}|${missing.sort().join(",")}`;
    const now = Date.now();
    const last = denyAuditCache.get(cacheKey);
    if (last && now - last < DENY_AUDIT_TTL_MS) return;
    denyAuditCache.set(cacheKey, now);

    // Lazy import to keep this module DB-free at the top level.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordSecurityAudit } = require("@/lib/security/audit") as typeof import("@/lib/security/audit");
    await recordSecurityAudit({
      tenantId: user.tenantId,
      category: "security.permission.denied",
      actorUserId: user.id,
      actorLabel: user.name,
      ipAddress: null,
      metadata: {
        path,
        role: user.role,
        missing,
        allowed_roles: opts.allowRoles ?? [],
      },
    });
  } catch (err) {
    // Never let audit failure surface to the caller — denial still
    // returns 403, that's what matters for security.
    console.error("[security] emitDeniedAudit failed:", err);
  }
}

/** Test-only — flush the throttle cache so denial audits emit again. */
export function _resetDenyAuditCache(): void {
  denyAuditCache.clear();
}
