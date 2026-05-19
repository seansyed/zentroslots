/**
 * PATCH /api/tenant/users/[id]/permissions
 * GET   /api/tenant/users/[id]/permissions
 *
 * Tenant-scoped per-user permission overrides for the granular flag
 * system (lib/security/permissions.ts).
 *
 * PATCH body shape:
 *   { flag: PermissionFlag, value: boolean | null }
 *
 *   - value = true   → grant the flag for this user (override role default)
 *   - value = false  → revoke the flag (override role default)
 *   - value = null   → REMOVE the override (fall back to role default)
 *
 * Privilege-escalation safeguards (Phase 7):
 *   1. SELF-GRANT: caller cannot modify their own permissions.
 *   2. CROSS-TENANT: target user must be in caller's tenant.
 *   3. UPLIFT: caller cannot grant a flag they themselves don't have.
 *   4. LAST-ADMIN: cannot remove canManageSecurity from the last user
 *      in the tenant who effectively holds it.
 *   5. CALLER MUST HAVE canManageSecurity to call this endpoint at all.
 *
 * Every successful change records security.permission.granted or
 * security.permission.revoked (append-only audit log).
 *
 * NEVER mutates other columns on the user row.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { users } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { ipFromHeaders } from "@/lib/audit";
import {
  PERMISSION_FLAGS,
  requirePermissionOrRole,
  effectivePermissions,
  userHasPermission,
} from "@/lib/security/permissions";
import { recordSecurityAudit } from "@/lib/security/audit";
import type { PermissionFlag } from "@/lib/security/permissions";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  flag: z.enum(PERMISSION_FLAGS as unknown as [PermissionFlag, ...PermissionFlag[]]),
  value: z.union([z.boolean(), z.null()]),
});

// ─── GET — effective permissions preview for a user ─────────────────

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requirePermissionOrRole({
      allowRoles: ["admin"],
      requirePermission: "canManageSecurity",
      auditPath: "/api/tenant/users/[id]/permissions",
    });

    const { id } = await context.params;
    if (!id) throw new HttpError(400, "Missing user id");

    const target = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) throw new HttpError(404, "User not found");

    // Cross-tenant guard.
    if (target.tenantId !== caller.tenantId) {
      throw new HttpError(404, "User not found"); // 404 not 403 — no existence leak
    }

    return NextResponse.json({
      userId: target.id,
      role: target.role,
      effective: effectivePermissions(target),
      overrides: (target.permissionsExtra ?? {}) as Record<string, boolean>,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── PATCH — set/remove an override ────────────────────────────────

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const caller = await requirePermissionOrRole({
      allowRoles: ["admin"],
      requirePermission: "canManageSecurity",
      auditPath: "/api/tenant/users/[id]/permissions",
    });

    const { id } = await context.params;
    if (!id) throw new HttpError(400, "Missing user id");
    const parsed = bodySchema.parse(await req.json());

    // ── Guard 1: SELF-GRANT prevention ────────────────────────────
    if (id === caller.id) {
      throw new HttpError(403, "Cannot modify your own permissions");
    }

    // ── Load target + cross-tenant guard ─────────────────────────
    const target = await db.query.users.findFirst({ where: eq(users.id, id) });
    if (!target) throw new HttpError(404, "User not found");
    if (target.tenantId !== caller.tenantId) {
      // 404 not 403 — no existence leak across tenants.
      throw new HttpError(404, "User not found");
    }

    // ── Guard 3: UPLIFT prevention ───────────────────────────────
    // To GRANT a flag, the caller must have it themselves. Removing
    // an override (value=null) and revoking (value=false) are
    // allowed regardless because they reduce privilege.
    if (parsed.value === true && !userHasPermission(caller, parsed.flag)) {
      throw new HttpError(403, "Cannot grant a permission you don't hold");
    }

    // ── Compute the new permissions_extra object ─────────────────
    const currentExtras = (target.permissionsExtra ?? {}) as Partial<Record<PermissionFlag, boolean>>;
    const newExtras: Partial<Record<PermissionFlag, boolean>> = { ...currentExtras };
    const previousValue: boolean | null = currentExtras[parsed.flag] ?? null;

    if (parsed.value === null) {
      delete newExtras[parsed.flag];
    } else {
      newExtras[parsed.flag] = parsed.value;
    }

    // ── Guard 4: LAST-ADMIN protection ───────────────────────────
    // If this change would revoke canManageSecurity from the target
    // AND the target currently holds it AND removing them leaves
    // zero users in the tenant who hold it, REFUSE.
    if (parsed.flag === "canManageSecurity") {
      const willTargetStillHaveIt = (() => {
        // Simulate the new user state for the permission check.
        const simulated = { ...target, permissionsExtra: newExtras } as typeof target;
        return userHasPermission(simulated, "canManageSecurity");
      })();
      if (!willTargetStillHaveIt && userHasPermission(target, "canManageSecurity")) {
        const stillHolds = await tenantHoldersOfFlag(caller.tenantId, "canManageSecurity", id);
        if (stillHolds === 0) {
          throw new HttpError(
            409,
            "Refusing — this would leave the workspace with no user holding canManageSecurity"
          );
        }
      }
    }

    // ── Persist + audit ──────────────────────────────────────────
    await db
      .update(users)
      .set({ permissionsExtra: newExtras, updatedAt: new Date() })
      .where(and(eq(users.id, target.id), eq(users.tenantId, caller.tenantId)));

    const ip = ipFromHeaders(req.headers);
    await recordSecurityAudit({
      tenantId: caller.tenantId,
      category: parsed.value === true ? "security.permission.granted" : "security.permission.revoked",
      actorUserId: caller.id,
      actorLabel: caller.name,
      entityType: "user",
      entityId: target.id,
      ipAddress: ip,
      metadata: {
        flag: parsed.flag,
        previous: previousValue,
        next: parsed.value,
        target_role: target.role,
      },
    });

    return NextResponse.json({
      ok: true,
      userId: target.id,
      effective: effectivePermissions({ ...target, permissionsExtra: newExtras } as typeof target),
      overrides: newExtras,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Counts how many users in the tenant currently hold the flag,
 *  optionally excluding a user we're about to mutate. Iterates in JS
 *  because the effective-permission computation isn't a SQL primitive
 *  (it blends role defaults + per-user jsonb overrides). N is small. */
async function tenantHoldersOfFlag(
  tenantId: string,
  flag: PermissionFlag,
  excludeUserId: string
): Promise<number> {
  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      permissionsExtra: users.permissionsExtra,
    })
    .from(users)
    .where(eq(users.tenantId, tenantId));

  let count = 0;
  for (const r of rows) {
    if (r.id === excludeUserId) continue;
    const stub = { role: r.role, permissionsExtra: r.permissionsExtra } as Parameters<typeof userHasPermission>[0];
    if (userHasPermission(stub, flag)) count++;
  }
  return count;
}
