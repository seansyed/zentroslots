/**
 * GET   /api/tenant/governance      — returns the effective policy
 * PATCH /api/tenant/governance      — partial update + audit
 *
 * Tenant-scoped via the caller's session. Gated by canManageSecurity.
 * PATCH validates inputs in lib/governance/policies.ts before writing
 * and emits security.governance.updated + (per changed field)
 * security.policy.changed audit rows.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { errorResponse, HttpError } from "@/lib/auth";
import { ipFromHeaders } from "@/lib/audit";
import { requirePermissionOrRole } from "@/lib/security/permissions";
import { recordSecurityAudit } from "@/lib/security/audit";
import {
  loadEffectivePolicy,
  upsertTenantGovernanceSettings,
  type GovernancePatch,
} from "@/lib/governance/policies";
import { SUSPICIOUS_SENSITIVITY } from "@/lib/governance/types";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  auditRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  sessionEventRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  resetTokenRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  analyticsRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  exportAuditRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),

  passwordMinLength: z.number().int().min(8).max(128).optional(),
  passwordRequireUppercase: z.boolean().optional(),
  passwordRequireLowercase: z.boolean().optional(),
  passwordRequireDigit: z.boolean().optional(),
  passwordRequireSymbol: z.boolean().optional(),
  passwordMaxAgeDays: z.number().int().min(0).max(365).optional(),

  sessionMaxAgeDays: z.number().int().min(0).max(30).optional(),
  suspiciousLoginSensitivity: z.enum(SUSPICIOUS_SENSITIVITY).optional(),

  allowedLoginIps: z.array(z.string().max(64)).max(64).nullable().optional(),
  restrictExports: z.boolean().optional(),
  maxExportRows: z.number().int().min(1).max(10_000_000).nullable().optional(),
  requireAutomationApproval: z.boolean().optional(),
});

const POLICY_FIELDS: Array<keyof GovernancePatch> = [
  "passwordMinLength",
  "passwordRequireUppercase",
  "passwordRequireLowercase",
  "passwordRequireDigit",
  "passwordRequireSymbol",
  "passwordMaxAgeDays",
  "sessionMaxAgeDays",
  "suspiciousLoginSensitivity",
];

export async function GET() {
  try {
    const user = await requirePermissionOrRole({
      allowRoles: ["admin"],
      requirePermission: "canManageSecurity",
      auditPath: "/api/tenant/governance",
    });
    const effective = await loadEffectivePolicy(user.tenantId);
    return NextResponse.json(effective);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const user = await requirePermissionOrRole({
      allowRoles: ["admin"],
      requirePermission: "canManageSecurity",
      auditPath: "/api/tenant/governance",
    });

    const raw = await req.json().catch(() => ({}));
    const parsed = patchSchema.parse(raw);

    // Snapshot the OLD effective policy so we can record what
    // actually changed in the audit row.
    const before = await loadEffectivePolicy(user.tenantId);
    const result = await upsertTenantGovernanceSettings(
      user.tenantId,
      parsed as GovernancePatch,
      user.id
    );
    if (!result.ok) {
      throw new HttpError(400, result.reason);
    }
    const after = result.effective;

    // One aggregate "updated" audit row.
    const ip = ipFromHeaders(req.headers);
    const changedFields = Object.keys(parsed).filter((k) => k in parsed);
    await recordSecurityAudit({
      tenantId: user.tenantId,
      category: "security.governance.updated",
      actorUserId: user.id,
      actorLabel: user.name,
      entityType: "governance",
      ipAddress: ip,
      metadata: {
        changed_fields: changedFields,
        had_custom_policy: before.hasCustomPolicy,
      },
    });

    // Per-policy-field "policy.changed" rows so a security review can
    // grep "what password rule changed when". Only for actual policy
    // fields, not retention windows (those have their own retention
    // audit category that fires when the engine actually runs).
    for (const f of POLICY_FIELDS) {
      if (!(f in parsed)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const next = (after as any)[mapToEffectivePath(f).area][mapToEffectivePath(f).key];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const prev = (before as any)[mapToEffectivePath(f).area][mapToEffectivePath(f).key];
      if (prev === next) continue;
      await recordSecurityAudit({
        tenantId: user.tenantId,
        category: "security.policy.changed",
        actorUserId: user.id,
        actorLabel: user.name,
        entityType: "policy",
        entityId: f,
        ipAddress: ip,
        metadata: { field: f, previous: prev, next },
      });
    }

    return NextResponse.json({ ok: true, effective: after });
  } catch (err) {
    return errorResponse(err);
  }
}

function mapToEffectivePath(field: keyof GovernancePatch): { area: keyof Awaited<ReturnType<typeof loadEffectivePolicy>>; key: string } {
  switch (field) {
    case "passwordMinLength":         return { area: "password", key: "minLength" };
    case "passwordRequireUppercase":  return { area: "password", key: "requireUppercase" };
    case "passwordRequireLowercase":  return { area: "password", key: "requireLowercase" };
    case "passwordRequireDigit":      return { area: "password", key: "requireDigit" };
    case "passwordRequireSymbol":     return { area: "password", key: "requireSymbol" };
    case "passwordMaxAgeDays":        return { area: "password", key: "maxAgeDays" };
    case "sessionMaxAgeDays":         return { area: "session", key: "maxAgeDays" };
    case "suspiciousLoginSensitivity":return { area: "session", key: "suspiciousLoginSensitivity" };
    default: return { area: "password", key: "minLength" }; // fallback unused
  }
}
