/**
 * Per-tenant governance policy loader + upserter.
 *
 *   loadEffectivePolicy(tenantId) — always returns an EffectiveGovernancePolicy.
 *      Tenants WITHOUT a row in tenant_governance_settings get the platform
 *      default (current behavior — preserves graceful degradation).
 *
 *   upsertTenantGovernanceSettings(tenantId, patch, actorUserId) —
 *      partial update keyed by tenant. Validates the patch before writing.
 *
 * NEVER cross-tenant: the actorUserId argument is only used for audit
 * attribution; tenant scoping comes from the explicit tenantId arg.
 */

import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantGovernanceSettings, type TenantGovernanceSettings } from "@/db/schema";
import { PLATFORM_DEFAULTS, type EffectiveGovernancePolicy, type SuspiciousSensitivity } from "./types";
import { validatePolicyUpdate, type PolicyValidationResult } from "./passwordPolicy";

export async function loadEffectivePolicy(tenantId: string): Promise<EffectiveGovernancePolicy> {
  let row: TenantGovernanceSettings | undefined;
  try {
    row = await db.query.tenantGovernanceSettings.findFirst({
      where: eq(tenantGovernanceSettings.tenantId, tenantId),
    });
  } catch (err) {
    console.error("[governance] loadEffectivePolicy db failure — falling back to platform defaults:", err);
    row = undefined;
  }

  if (!row) {
    return {
      tenantId,
      retention: {
        auditLogs: null,
        sessionEvents: null,
        resetTokens: null,
        analytics: null,
        exportAudit: null,
      },
      password: {
        minLength: PLATFORM_DEFAULTS.passwordMinLength,
        requireUppercase: PLATFORM_DEFAULTS.passwordRequireUppercase,
        requireLowercase: PLATFORM_DEFAULTS.passwordRequireLowercase,
        requireDigit: PLATFORM_DEFAULTS.passwordRequireDigit,
        requireSymbol: PLATFORM_DEFAULTS.passwordRequireSymbol,
        maxAgeDays: PLATFORM_DEFAULTS.passwordMaxAgeDays,
      },
      session: {
        maxAgeDays: PLATFORM_DEFAULTS.sessionMaxAgeDays,
        suspiciousLoginSensitivity: PLATFORM_DEFAULTS.suspiciousLoginSensitivity,
      },
      exports: {
        restrict: PLATFORM_DEFAULTS.restrictExports,
        maxRows: null,
      },
      automation: {
        requireApproval: PLATFORM_DEFAULTS.requireAutomationApproval,
      },
      allowedLoginIps: null,
      hasCustomPolicy: false,
    };
  }

  return {
    tenantId,
    retention: {
      auditLogs: row.auditRetentionDays,
      sessionEvents: row.sessionEventRetentionDays,
      resetTokens: row.resetTokenRetentionDays,
      analytics: row.analyticsRetentionDays,
      exportAudit: row.exportAuditRetentionDays,
    },
    password: {
      minLength: row.passwordMinLength,
      requireUppercase: row.passwordRequireUppercase,
      requireLowercase: row.passwordRequireLowercase,
      requireDigit: row.passwordRequireDigit,
      requireSymbol: row.passwordRequireSymbol,
      maxAgeDays: row.passwordMaxAgeDays,
    },
    session: {
      maxAgeDays: row.sessionMaxAgeDays,
      suspiciousLoginSensitivity: row.suspiciousLoginSensitivity as SuspiciousSensitivity,
    },
    exports: {
      restrict: row.restrictExports,
      maxRows: row.maxExportRows,
    },
    automation: {
      requireApproval: row.requireAutomationApproval,
    },
    allowedLoginIps: (row.allowedLoginIps as string[] | null) ?? null,
    hasCustomPolicy: true,
  };
}

export type GovernancePatch = {
  auditRetentionDays?: number | null;
  sessionEventRetentionDays?: number | null;
  resetTokenRetentionDays?: number | null;
  analyticsRetentionDays?: number | null;
  exportAuditRetentionDays?: number | null;

  passwordMinLength?: number;
  passwordRequireUppercase?: boolean;
  passwordRequireLowercase?: boolean;
  passwordRequireDigit?: boolean;
  passwordRequireSymbol?: boolean;
  passwordMaxAgeDays?: number;

  sessionMaxAgeDays?: number;
  suspiciousLoginSensitivity?: SuspiciousSensitivity;

  allowedLoginIps?: string[] | null;
  restrictExports?: boolean;
  maxExportRows?: number | null;
  requireAutomationApproval?: boolean;
};

export type UpsertResult =
  | { ok: true; effective: EffectiveGovernancePolicy }
  | { ok: false; reason: string };

export async function upsertTenantGovernanceSettings(
  tenantId: string,
  patch: GovernancePatch,
  actorUserId: string
): Promise<UpsertResult> {
  // 1. Policy validation — reject unsafe inputs BEFORE touching the DB.
  const v: PolicyValidationResult = validatePolicyUpdate(patch);
  if (!v.ok) return { ok: false, reason: v.reason };

  // 2. Retention windows must be positive integers when set.
  for (const [k, val] of Object.entries({
    auditRetentionDays: patch.auditRetentionDays,
    sessionEventRetentionDays: patch.sessionEventRetentionDays,
    resetTokenRetentionDays: patch.resetTokenRetentionDays,
    analyticsRetentionDays: patch.analyticsRetentionDays,
    exportAuditRetentionDays: patch.exportAuditRetentionDays,
  })) {
    if (val === undefined || val === null) continue;
    if (!Number.isInteger(val) || val < 1 || val > 3650) {
      return { ok: false, reason: `${k} must be a positive integer (≤ 3650) or null.` };
    }
  }

  // 3. Allowed login IPs — bounded list of strings if present.
  if (patch.allowedLoginIps !== undefined && patch.allowedLoginIps !== null) {
    if (!Array.isArray(patch.allowedLoginIps) || patch.allowedLoginIps.length > 64) {
      return { ok: false, reason: "allowedLoginIps must be a list of at most 64 CIDR strings." };
    }
    for (const ip of patch.allowedLoginIps) {
      if (typeof ip !== "string" || ip.length > 64) {
        return { ok: false, reason: "Each allowedLoginIps entry must be a string." };
      }
    }
  }

  // 4. UPSERT. Drizzle's onConflictDoUpdate keeps the row + tenant_id
  //    intact and only overwrites the fields the operator sent.
  try {
    await db
      .insert(tenantGovernanceSettings)
      .values({
        tenantId,
        ...(patch.auditRetentionDays !== undefined ? { auditRetentionDays: patch.auditRetentionDays } : {}),
        ...(patch.sessionEventRetentionDays !== undefined ? { sessionEventRetentionDays: patch.sessionEventRetentionDays } : {}),
        ...(patch.resetTokenRetentionDays !== undefined ? { resetTokenRetentionDays: patch.resetTokenRetentionDays } : {}),
        ...(patch.analyticsRetentionDays !== undefined ? { analyticsRetentionDays: patch.analyticsRetentionDays } : {}),
        ...(patch.exportAuditRetentionDays !== undefined ? { exportAuditRetentionDays: patch.exportAuditRetentionDays } : {}),
        ...(patch.passwordMinLength !== undefined ? { passwordMinLength: patch.passwordMinLength } : {}),
        ...(patch.passwordRequireUppercase !== undefined ? { passwordRequireUppercase: patch.passwordRequireUppercase } : {}),
        ...(patch.passwordRequireLowercase !== undefined ? { passwordRequireLowercase: patch.passwordRequireLowercase } : {}),
        ...(patch.passwordRequireDigit !== undefined ? { passwordRequireDigit: patch.passwordRequireDigit } : {}),
        ...(patch.passwordRequireSymbol !== undefined ? { passwordRequireSymbol: patch.passwordRequireSymbol } : {}),
        ...(patch.passwordMaxAgeDays !== undefined ? { passwordMaxAgeDays: patch.passwordMaxAgeDays } : {}),
        ...(patch.sessionMaxAgeDays !== undefined ? { sessionMaxAgeDays: patch.sessionMaxAgeDays } : {}),
        ...(patch.suspiciousLoginSensitivity !== undefined ? { suspiciousLoginSensitivity: patch.suspiciousLoginSensitivity } : {}),
        ...(patch.allowedLoginIps !== undefined ? { allowedLoginIps: patch.allowedLoginIps } : {}),
        ...(patch.restrictExports !== undefined ? { restrictExports: patch.restrictExports } : {}),
        ...(patch.maxExportRows !== undefined ? { maxExportRows: patch.maxExportRows } : {}),
        ...(patch.requireAutomationApproval !== undefined ? { requireAutomationApproval: patch.requireAutomationApproval } : {}),
        updatedByUserId: actorUserId,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: tenantGovernanceSettings.tenantId,
        set: {
          ...(patch.auditRetentionDays !== undefined ? { auditRetentionDays: patch.auditRetentionDays } : {}),
          ...(patch.sessionEventRetentionDays !== undefined ? { sessionEventRetentionDays: patch.sessionEventRetentionDays } : {}),
          ...(patch.resetTokenRetentionDays !== undefined ? { resetTokenRetentionDays: patch.resetTokenRetentionDays } : {}),
          ...(patch.analyticsRetentionDays !== undefined ? { analyticsRetentionDays: patch.analyticsRetentionDays } : {}),
          ...(patch.exportAuditRetentionDays !== undefined ? { exportAuditRetentionDays: patch.exportAuditRetentionDays } : {}),
          ...(patch.passwordMinLength !== undefined ? { passwordMinLength: patch.passwordMinLength } : {}),
          ...(patch.passwordRequireUppercase !== undefined ? { passwordRequireUppercase: patch.passwordRequireUppercase } : {}),
          ...(patch.passwordRequireLowercase !== undefined ? { passwordRequireLowercase: patch.passwordRequireLowercase } : {}),
          ...(patch.passwordRequireDigit !== undefined ? { passwordRequireDigit: patch.passwordRequireDigit } : {}),
          ...(patch.passwordRequireSymbol !== undefined ? { passwordRequireSymbol: patch.passwordRequireSymbol } : {}),
          ...(patch.passwordMaxAgeDays !== undefined ? { passwordMaxAgeDays: patch.passwordMaxAgeDays } : {}),
          ...(patch.sessionMaxAgeDays !== undefined ? { sessionMaxAgeDays: patch.sessionMaxAgeDays } : {}),
          ...(patch.suspiciousLoginSensitivity !== undefined ? { suspiciousLoginSensitivity: patch.suspiciousLoginSensitivity } : {}),
          ...(patch.allowedLoginIps !== undefined ? { allowedLoginIps: patch.allowedLoginIps } : {}),
          ...(patch.restrictExports !== undefined ? { restrictExports: patch.restrictExports } : {}),
          ...(patch.maxExportRows !== undefined ? { maxExportRows: patch.maxExportRows } : {}),
          ...(patch.requireAutomationApproval !== undefined ? { requireAutomationApproval: patch.requireAutomationApproval } : {}),
          updatedByUserId: actorUserId,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error("[governance] upsert failed:", err);
    return { ok: false, reason: "Could not persist governance settings." };
  }

  const effective = await loadEffectivePolicy(tenantId);
  return { ok: true, effective };
}
