import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
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
import { canManuallyEnable } from "@/lib/business-phone-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/business-phone/toggle — super-admin enables/disables a
 * tenant's Business Phone service WITHOUT deleting numbers or call logs.
 *
 * Disable just flips tenant_phone_settings.enabled=false (blocks inbound +
 * outbound; the bridge already rejects line_disabled and inbound is gated on the
 * same flag). Enable requires an active add-on (or manual pilot) AND an assigned
 * active number. Never touches Telnyx config or numbers.
 */

const toggleSchema = z.object({
  tenantId: z.string().uuid(),
  enabled: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin();
    const body = toggleSchema.parse(await req.json());

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, body.tenantId),
      columns: { id: true, currentPlan: true },
    });
    if (!tenant) throw new HttpError(404, "Tenant not found.");

    const settings = await db.query.tenantPhoneSettings.findFirst({
      where: eq(tenantPhoneSettings.tenantId, body.tenantId),
      columns: { id: true, metadata: true },
    });
    if (!settings) {
      throw new HttpError(409, "This tenant has no Business Phone settings yet — assign a number first.");
    }

    if (body.enabled) {
      const planEligible = canUseBusinessLine(getPlan(tenant.currentPlan)).allowed;
      const addonActive = readAddonActiveFlag(settings.metadata);
      const manualSource = readEntitlementSource(settings.metadata) === "manual";
      const entitledOrManual = (planEligible && addonActive) || manualSource;

      const activeNumber = await db.query.tenantPhoneNumbers.findFirst({
        where: and(eq(tenantPhoneNumbers.tenantId, body.tenantId), eq(tenantPhoneNumbers.status, "active")),
        columns: { id: true },
      });

      if (!canManuallyEnable({ entitledOrManual, numberAssigned: Boolean(activeNumber) })) {
        throw new HttpError(
          409,
          "Can't enable — requires an active Business Phone add-on (or manual pilot) and an assigned number.",
        );
      }
    }

    await db
      .update(tenantPhoneSettings)
      .set({ enabled: body.enabled, updatedAt: new Date() })
      .where(eq(tenantPhoneSettings.tenantId, body.tenantId));

    audit({
      tenantId: body.tenantId,
      action: body.enabled ? "business_phone.enabled" : "business_phone.disabled",
      actorUserId: admin.sub,
      actorLabel: admin.email,
      entityType: "business_phone_settings",
      entityId: body.tenantId,
      metadata: { enabled: body.enabled, reason: body.reason ?? null },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({ ok: true, tenantId: body.tenantId, enabled: body.enabled });
  } catch (err) {
    return errorResponse(err);
  }
}
