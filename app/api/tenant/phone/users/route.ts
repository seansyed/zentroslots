import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenantPhoneUsers, users } from "@/db/schema";
import { errorResponse, requireRole, HttpError } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { validateForwardingUpdate, forwardingErrorMessage } from "@/lib/business-line-view";
import { maskPhoneNumber } from "@/lib/business-line-bridge";
import { getTenantBusinessPhone, getStaffPhone } from "@/lib/business-phone-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operator (admin/manager) staff Business Phone access management. Minimal by
// design: list staff identities + toggle enabled/can_place_calls + set/clear a
// staff member's bridge number. Numbers are returned MASKED only. No call
// placement, no Telnyx here.

/**
 * GET — list the tenant's STAFF users with their Business Phone access state
 * (masked numbers only). LEFT JOIN so staff WITHOUT an identity row appear too
 * (default: no access) — that's how an operator grants access to someone new.
 */
export async function GET() {
  try {
    const operator = await requireRole(["admin", "manager"]);
    const tenantId = operator.tenantId;

    const rows = await db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        enabled: tenantPhoneUsers.enabled,
        canPlaceCalls: tenantPhoneUsers.canPlaceCalls,
        canReceiveCalls: tenantPhoneUsers.canReceiveCalls,
        bridgePhoneNumber: tenantPhoneUsers.bridgePhoneNumber,
        updatedAt: tenantPhoneUsers.updatedAt,
      })
      .from(users)
      .leftJoin(
        tenantPhoneUsers,
        and(eq(tenantPhoneUsers.userId, users.id), eq(tenantPhoneUsers.tenantId, tenantId)),
      )
      .where(and(eq(users.tenantId, tenantId), eq(users.role, "staff")));

    return NextResponse.json({
      users: rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        role: r.role,
        enabled: r.enabled ?? false,
        canPlaceCalls: r.canPlaceCalls ?? false,
        canReceiveCalls: r.canReceiveCalls ?? false,
        bridgePhoneNumberConfigured: Boolean(r.bridgePhoneNumber),
        bridgePhoneNumberMasked: maskPhoneNumber(r.bridgePhoneNumber),
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const patchSchema = z
  .object({
    userId: z.string().uuid(),
    enabled: z.boolean().optional(),
    canPlaceCalls: z.boolean().optional(),
    bridgePhoneNumber: z.string().max(40).nullable().optional(),
  })
  .refine(
    (b) => b.enabled !== undefined || b.canPlaceCalls !== undefined || b.bridgePhoneNumber !== undefined,
    { message: "Nothing to update." },
  );

/** PATCH — an operator sets a staff member's access / bridge number. */
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireRole(["admin", "manager"]);
    const tenantId = admin.tenantId;
    const body = patchSchema.parse(await req.json());

    // The target user must belong to the admin's tenant.
    const target = await db.query.users.findFirst({
      where: and(eq(users.id, body.userId), eq(users.tenantId, tenantId)),
      columns: { id: true },
    });
    if (!target) throw new HttpError(404, "User not found.");

    const bp = await getTenantBusinessPhone(tenantId);

    // Gate: granting access (enable / allow calls / set a number) requires an
    // active subscription. Revoking (disable / clear) is always allowed.
    const setsNonEmptyNumber =
      typeof body.bridgePhoneNumber === "string" && body.bridgePhoneNumber.trim() !== "";
    const grantsAccess = body.enabled === true || body.canPlaceCalls === true || setsNonEmptyNumber;
    if (!bp.entitled && grantsAccess) {
      throw new HttpError(402, "The Business Phone add-on isn't active on your plan.");
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.canPlaceCalls !== undefined) patch.canPlaceCalls = body.canPlaceCalls;
    if (body.bridgePhoneNumber !== undefined) {
      const raw = body.bridgePhoneNumber;
      if (raw === null || raw.trim() === "") {
        patch.bridgePhoneNumber = null;
      } else {
        const v = validateForwardingUpdate({ forwardingNumber: raw, ownedNumbers: bp.ownedNumbers });
        if (!v.ok) throw new HttpError(400, forwardingErrorMessage(v.reason));
        patch.bridgePhoneNumber = v.e164;
      }
    }

    await db
      .insert(tenantPhoneUsers)
      .values({
        tenantId,
        userId: body.userId,
        enabled: (patch.enabled as boolean | undefined) ?? true,
        canPlaceCalls: (patch.canPlaceCalls as boolean | undefined) ?? true,
        bridgePhoneNumber: (patch.bridgePhoneNumber as string | null | undefined) ?? null,
      } as typeof tenantPhoneUsers.$inferInsert)
      .onConflictDoUpdate({
        target: [tenantPhoneUsers.tenantId, tenantPhoneUsers.userId],
        set: patch,
      });

    audit({
      tenantId,
      action: "business_phone.staff_access_updated",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "business_phone_user",
      entityId: body.userId,
      metadata: {
        targetUserId: body.userId,
        enabledChanged: body.enabled !== undefined,
        canPlaceChanged: body.canPlaceCalls !== undefined,
        numberChanged: body.bridgePhoneNumber !== undefined,
      },
      ipAddress: ipFromHeaders(req.headers),
    });

    const updated = await getStaffPhone(tenantId, body.userId);
    return NextResponse.json({
      ok: true,
      userId: body.userId,
      enabled: updated?.enabled ?? null,
      canPlaceCalls: updated?.canPlaceCalls ?? null,
      bridgePhoneNumberConfigured: Boolean(updated?.bridgePhoneNumber),
      bridgePhoneNumberMasked: maskPhoneNumber(updated?.bridgePhoneNumber),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
