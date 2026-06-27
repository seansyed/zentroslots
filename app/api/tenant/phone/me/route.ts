import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenantPhoneUsers, phoneUsageMonthly } from "@/db/schema";
import { errorResponse, requireUser, HttpError } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { secondsToBillableMinutes } from "@/lib/business-line";
import {
  periodForDate,
  validateForwardingUpdate,
  forwardingErrorMessage,
} from "@/lib/business-line-view";
import { resolveStaffBridge, maskPhoneNumber } from "@/lib/business-line-bridge";
import { getTenantBusinessPhone, getStaffPhone } from "@/lib/business-phone-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-user Business Phone capability + self-service bridge-number config (P1.1).
// Any authenticated user may read/update their OWN identity. The personal bridge
// number is NEVER returned in full — only a masked form. Server is the source of
// truth: an unentitled tenant cannot configure a number.

type MeView = {
  hasBusinessPhone: boolean; // tenant entitled (plan + add-on)
  lineEnabled: boolean; // tenant line on/off
  canPlaceCalls: boolean; // a call from this user would be permitted right now
  businessNumber: string | null; // caller ID shown to customers (null unless entitled)
  bridgePhoneNumberConfigured: boolean;
  bridgePhoneNumberMasked: string | null;
  usage: { period: string; minutesUsed: number; cap: number } | null;
};

async function buildMeView(tenantId: string, userId: string): Promise<MeView> {
  const period = periodForDate(new Date());
  const [bp, staff, usage] = await Promise.all([
    getTenantBusinessPhone(tenantId),
    getStaffPhone(tenantId, userId),
    db.query.phoneUsageMonthly.findFirst({
      where: and(eq(phoneUsageMonthly.tenantId, tenantId), eq(phoneUsageMonthly.period, period)),
    }),
  ]);

  const resolved = resolveStaffBridge({
    staffRowExists: Boolean(staff),
    staffEnabled: staff?.enabled ?? false,
    staffCanPlaceCalls: staff?.canPlaceCalls ?? false,
    staffBridgeNumber: staff?.bridgePhoneNumber ?? null,
    tenantFallbackNumber: bp.forwardingNumber,
  });
  const canPlaceCalls = bp.entitled && bp.settingsEnabled && resolved.kind === "ok";

  return {
    hasBusinessPhone: bp.entitled,
    lineEnabled: bp.settingsEnabled,
    canPlaceCalls,
    businessNumber: bp.entitled ? bp.businessNumber : null,
    bridgePhoneNumberConfigured: Boolean(staff?.bridgePhoneNumber),
    bridgePhoneNumberMasked: maskPhoneNumber(staff?.bridgePhoneNumber),
    usage: bp.entitled
      ? {
          period,
          minutesUsed: secondsToBillableMinutes(usage?.billableSeconds ?? 0),
          cap: bp.monthlyMinuteCap,
        }
      : null,
  };
}

/** GET — the calling user's Business Phone capability. */
export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(await buildMeView(user.tenantId, user.id));
  } catch (err) {
    return errorResponse(err);
  }
}

const patchSchema = z
  .object({
    // null / "" clears the user's bridge number.
    bridgePhoneNumber: z.string().max(40).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => b.bridgePhoneNumber !== undefined || b.enabled !== undefined, {
    message: "Nothing to update.",
  });

/** PATCH — the calling user sets/updates their OWN bridge number / enabled flag. */
export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser();
    const tenantId = user.tenantId;
    const body = patchSchema.parse(await req.json());

    const bp = await getTenantBusinessPhone(tenantId);

    // Gate writes: enabling or setting a number requires an active subscription.
    // Disabling / clearing is always allowed (mirrors the settings PATCH gate).
    const setsNonEmptyNumber =
      typeof body.bridgePhoneNumber === "string" && body.bridgePhoneNumber.trim() !== "";
    if (!bp.entitled && (setsNonEmptyNumber || body.enabled === true)) {
      throw new HttpError(402, "The Business Phone add-on isn't active on your plan.");
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.bridgePhoneNumber !== undefined) {
      const raw = body.bridgePhoneNumber;
      if (raw === null || raw.trim() === "") {
        patch.bridgePhoneNumber = null;
      } else {
        // Valid US/CA number, and not one of the tenant's own business numbers.
        const v = validateForwardingUpdate({ forwardingNumber: raw, ownedNumbers: bp.ownedNumbers });
        if (!v.ok) throw new HttpError(400, forwardingErrorMessage(v.reason));
        patch.bridgePhoneNumber = v.e164;
      }
    }

    // Upsert the single per-(tenant,user) identity row. New rows default to
    // enabled + can_place_calls (an admin can later revoke via /phone/users).
    await db
      .insert(tenantPhoneUsers)
      .values({
        tenantId,
        userId: user.id,
        bridgePhoneNumber: (patch.bridgePhoneNumber as string | null | undefined) ?? null,
        enabled: (patch.enabled as boolean | undefined) ?? true,
      } as typeof tenantPhoneUsers.$inferInsert)
      .onConflictDoUpdate({
        target: [tenantPhoneUsers.tenantId, tenantPhoneUsers.userId],
        set: patch,
      });

    audit({
      tenantId,
      action: "business_phone.staff_settings_updated",
      actorUserId: user.id,
      actorLabel: user.email,
      entityType: "business_phone_user",
      entityId: user.id,
      metadata: {
        numberChanged: body.bridgePhoneNumber !== undefined,
        enabledChanged: body.enabled !== undefined,
      },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json(await buildMeView(tenantId, user.id));
  } catch (err) {
    return errorResponse(err);
  }
}
