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
