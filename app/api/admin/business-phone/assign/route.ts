import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenants, tenantPhoneSettings, tenantPhoneNumbers } from "@/db/schema";
import { errorResponse, HttpError } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/super-admin";
import { getPlan } from "@/lib/plans";
import { canUseBusinessLine } from "@/lib/billing/capabilities";
import { readAddonActiveFlag } from "@/lib/business-line-view";
import { readEntitlementSource } from "@/lib/business-phone-addon";
import {
  validateAssignInput,
  classifyNumberAssignment,
  assignEnabledState,
  resolveBusinessPhoneSetupState,
  isSuspendedSubscriptionStatus,
} from "@/lib/business-phone-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/business-phone/assign — super-admin assigns an
 * ALREADY-PROVISIONED Telnyx number to a tenant and records the forwarding
 * number. We NEVER call Telnyx, never buy a number, never change Telnyx app
 * config — the operator owns the number out-of-band; this only records it.
 *
 * Validates US/CA E.164 (rejects emergency/N11/international), refuses a number
 * already assigned to another tenant, then upserts tenant_phone_numbers (active)
 * + tenant_phone_settings (forwarding + included minutes). The line is enabled
 * only when the tenant is entitled (or a manual pilot) AND both numbers exist.
 * Entitlement itself is NOT granted here — that stays webhook-driven.
 */

const assignSchema = z.object({
  tenantId: z.string().uuid(),
  businessPhoneNumber: z.string().trim().min(1).max(40),
  forwardingNumber: z.string().trim().min(1).max(40),
  label: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(500).optional(),
  includedMinutes: z.number().int().min(0).max(100_000).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin();
    const body = assignSchema.parse(await req.json());

    const v = validateAssignInput(body);
    if (!v.ok) throw new HttpError(400, v.reason);

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, body.tenantId),
      columns: { id: true, currentPlan: true, subscriptionStatus: true },
    });
    if (!tenant) throw new HttpError(404, "Tenant not found.");

    const settings = await db.query.tenantPhoneSettings.findFirst({
      where: eq(tenantPhoneSettings.tenantId, body.tenantId),
      columns: { id: true, metadata: true },
    });

    const planEligible = canUseBusinessLine(getPlan(tenant.currentPlan)).allowed;
    const addonActive = readAddonActiveFlag(settings?.metadata);
    const manualSource = readEntitlementSource(settings?.metadata) === "manual";
    const entitledOrManual = (planEligible && addonActive) || manualSource;

    // Reject a number already registered to another tenant. Same-tenant rows are
    // reactivated/updated; we never silently move a number between tenants.
    const existingNumber = await db.query.tenantPhoneNumbers.findFirst({
      where: eq(tenantPhoneNumbers.phoneNumber, v.businessE164),
      columns: { id: true, tenantId: true, status: true },
    });
    const cls = classifyNumberAssignment(existingNumber, body.tenantId);
    if (cls === "conflict_active") {
      throw new HttpError(409, "That number is already assigned to another tenant.");
    }
    if (cls === "conflict_other") {
      throw new HttpError(409, "That number is registered to another tenant — release it there first.");
    }

    const numberMetadata =
      body.label || body.notes ? { label: body.label ?? null, notes: body.notes ?? null } : null;

    if (cls === "insert") {
      await db.insert(tenantPhoneNumbers).values({
        tenantId: body.tenantId,
        phoneNumber: v.businessE164,
        status: "active",
        provisionedAt: new Date(),
        metadata: numberMetadata,
      } as typeof tenantPhoneNumbers.$inferInsert);
    } else {
      // reactivate / update this tenant's existing row for the same number
      await db
        .update(tenantPhoneNumbers)
        .set({
          status: "active",
          provisionedAt: new Date(),
          updatedAt: new Date(),
          ...(numberMetadata ? { metadata: numberMetadata } : {}),
        })
        .where(eq(tenantPhoneNumbers.id, existingNumber!.id));
    }

    const enabled = assignEnabledState({ entitledOrManual, hasBusinessNumber: true, hasForwarding: true });

    // Upsert settings. Preserve existing metadata (entitlement flags). Hard cap =
    // included minutes (no overage). NOTE: entitlement is NOT written here.
    if (settings) {
      await db
        .update(tenantPhoneSettings)
        .set({
          forwardingNumber: v.forwardingE164,
          includedMinutes: v.includedMinutes,
          monthlyMinuteCap: v.includedMinutes,
          enabled,
          updatedAt: new Date(),
        })
        .where(eq(tenantPhoneSettings.tenantId, body.tenantId));
    } else {
      await db
        .insert(tenantPhoneSettings)
        .values({
          tenantId: body.tenantId,
          forwardingNumber: v.forwardingE164,
          includedMinutes: v.includedMinutes,
          monthlyMinuteCap: v.includedMinutes,
          enabled,
          metadata: null,
        } as typeof tenantPhoneSettings.$inferInsert)
        .onConflictDoNothing({ target: tenantPhoneSettings.tenantId });
    }

    const setupState = resolveBusinessPhoneSetupState({
      entitled: entitledOrManual,
      numberAssigned: true,
      settingsEnabled: enabled,
      suspended: !entitledOrManual && isSuspendedSubscriptionStatus(tenant.subscriptionStatus),
    });

    audit({
      tenantId: body.tenantId,
      action: "business_phone.number_assigned",
      actorUserId: admin.sub,
      actorLabel: admin.email,
      entityType: "business_phone_number",
      entityId: body.tenantId,
      metadata: { action: cls, enabled, includedMinutes: v.includedMinutes },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({
      ok: true,
      tenantId: body.tenantId,
      // Super-admin operational view — full numbers (no API keys / secrets).
      businessPhoneNumber: v.businessE164,
      forwardingNumber: v.forwardingE164,
      includedMinutes: v.includedMinutes,
      enabled,
      entitled: entitledOrManual,
      setupState,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
