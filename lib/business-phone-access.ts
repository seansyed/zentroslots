// DB-touching access helpers for the ZentroMeet Business Phone module (P1.1).
//
// Centralizes the two reads every Phone route needs so the entitlement +
// staff-identity logic lives in ONE place (the routes stay thin): the tenant's
// Business Phone entitlement/state, and a staff member's phone identity row.
// Pure decision logic stays in lib/business-line-bridge.ts; this module only
// loads + folds DB state (mirrors lib/tenant.ts). No Telnyx, no React.

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  tenants,
  tenantPhoneNumbers,
  tenantPhoneSettings,
  tenantPhoneUsers,
  type TenantPhoneUser,
} from "@/db/schema";
import { getPlan } from "@/lib/plans";
import { canUseBusinessLine } from "@/lib/billing/capabilities";
import { readAddonActiveFlag } from "@/lib/business-line-view";
import { resolveStaffBridge } from "@/lib/business-line-bridge";

export type TenantBusinessPhone = {
  /** Pro+ plan gate. */
  planEligible: boolean;
  /** Add-on activation flag (settings metadata). */
  addonActive: boolean;
  /** The visibility/entitlement truth: BOTH gates pass. */
  entitled: boolean;
  /** The tenant Business Phone line on/off switch. */
  settingsEnabled: boolean;
  /** The tenant's active business number (caller ID source), or null. */
  businessNumber: string | null;
  /** All of the tenant's business numbers (loop/self-call guard). */
  ownedNumbers: string[];
  /** Tenant forwarding number — the leg-1 fallback. */
  forwardingNumber: string | null;
  /** Monthly minute cap (0 = none). */
  monthlyMinuteCap: number;
};

/**
 * Resolve a tenant's Business Phone entitlement + state. `entitled` is the
 * server-side source of truth for show/hide on web + mobile (plan AND add-on).
 */
export async function getTenantBusinessPhone(tenantId: string): Promise<TenantBusinessPhone> {
  const [numberRow, settings, owned, tenantRow] = await Promise.all([
    db.query.tenantPhoneNumbers.findFirst({
      where: and(eq(tenantPhoneNumbers.tenantId, tenantId), eq(tenantPhoneNumbers.status, "active")),
    }),
    db.query.tenantPhoneSettings.findFirst({ where: eq(tenantPhoneSettings.tenantId, tenantId) }),
    db.query.tenantPhoneNumbers.findMany({
      where: eq(tenantPhoneNumbers.tenantId, tenantId),
      columns: { phoneNumber: true },
    }),
    db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { currentPlan: true } }),
  ]);

  const planEligible = canUseBusinessLine(getPlan(tenantRow?.currentPlan)).allowed;
  const addonActive = readAddonActiveFlag(settings?.metadata);
  return {
    planEligible,
    addonActive,
    entitled: planEligible && addonActive,
    settingsEnabled: settings?.enabled ?? false,
    businessNumber: numberRow?.phoneNumber ?? null,
    ownedNumbers: owned.map((o) => o.phoneNumber),
    forwardingNumber: settings?.forwardingNumber ?? null,
    monthlyMinuteCap: settings?.monthlyMinuteCap ?? 0,
  };
}

/** A single staff member's Business Phone identity row, or null. */
export async function getStaffPhone(
  tenantId: string,
  userId: string,
): Promise<TenantPhoneUser | null> {
  const row = await db.query.tenantPhoneUsers.findFirst({
    where: and(eq(tenantPhoneUsers.tenantId, tenantId), eq(tenantPhoneUsers.userId, userId)),
  });
  return row ?? null;
}

/**
 * Lightweight entitlement-only check for hot paths (e.g. GET /api/auth/me) that
 * already hold the tenant's plan — avoids re-reading the tenants row. Returns
 * whether the tenant can see/use Business Phone.
 */
export async function isBusinessPhoneEntitled(tenantId: string, plan: string | null | undefined): Promise<boolean> {
  const planEligible = canUseBusinessLine(getPlan(plan)).allowed;
  if (!planEligible) return false;
  const settings = await db.query.tenantPhoneSettings.findFirst({
    where: eq(tenantPhoneSettings.tenantId, tenantId),
    columns: { metadata: true },
  });
  return readAddonActiveFlag(settings?.metadata);
}

export type UserBusinessPhoneVisibility = {
  /** Tenant entitled (Pro+ plan AND active add-on). */
  entitled: boolean;
  /** May this user open the Phone module? Operators always (when entitled);
   *  staff only with an enabled, can-place identity granted by an admin. */
  hasPhoneAccess: boolean;
  /** Can this user place a call RIGHT NOW (entitled + line on + a usable leg-1
   *  number resolves)? Gates the call buttons. */
  canPlaceCalls: boolean;
};

/**
 * Per-user Business Phone visibility for nav + page gating (P1.2.1). Lean: only
 * reads beyond the plan check run for plan-eligible tenants (≈ Pro+). Plumbs the
 * same staff resolution the calls route uses, so the client and server agree.
 */
export async function getUserBusinessPhoneVisibility(
  tenantId: string,
  userId: string,
  role: string,
  plan: string | null | undefined,
): Promise<UserBusinessPhoneVisibility> {
  const denied = { entitled: false, hasPhoneAccess: false, canPlaceCalls: false };
  if (!canUseBusinessLine(getPlan(plan)).allowed) return denied;

  const [settings, staff] = await Promise.all([
    db.query.tenantPhoneSettings.findFirst({
      where: eq(tenantPhoneSettings.tenantId, tenantId),
      columns: { metadata: true, enabled: true, forwardingNumber: true },
    }),
    getStaffPhone(tenantId, userId),
  ]);
  if (!readAddonActiveFlag(settings?.metadata)) return denied;

  const resolved = resolveStaffBridge({
    staffRowExists: Boolean(staff),
    staffEnabled: staff?.enabled ?? false,
    staffCanPlaceCalls: staff?.canPlaceCalls ?? false,
    staffBridgeNumber: staff?.bridgePhoneNumber ?? null,
    tenantFallbackNumber: settings?.forwardingNumber ?? null,
  });
  const canPlaceCalls = (settings?.enabled ?? false) && resolved.kind === "ok";
  const isOperator = role === "admin" || role === "manager";
  const staffPermitted = Boolean(staff?.enabled && staff?.canPlaceCalls);
  return { entitled: true, hasPhoneAccess: isOperator || staffPermitted, canPlaceCalls };
}
