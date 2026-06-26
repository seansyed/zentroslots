import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import {
  tenants,
  tenantPhoneNumbers,
  tenantPhoneSettings,
  phoneUsageMonthly,
  phoneCallLogs,
} from "@/db/schema";
import { errorResponse, requireRole, HttpError } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { getPlan } from "@/lib/plans";
import { canUseBusinessLine } from "@/lib/billing/capabilities";
import {
  shapeBusinessLineView,
  validateForwardingUpdate,
  forwardingErrorMessage,
  periodForDate,
  readAddonActiveFlag,
  evaluateBusinessLinePatchGate,
} from "@/lib/business-line-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only. This is the settings surface ONLY — it never provisions a number,
// never calls Telnyx, and never forwards a call. It reads/writes the additive
// 0077 Business Line tables (which must exist — i.e. migration 0077 applied —
// before this route can run in production).

const RECENT_CALLS_LIMIT = 10;

/** GET — the full Business Line view for the calling admin's tenant. */
export async function GET() {
  try {
    const admin = await requireRole(["admin"]);
    const tenantId = admin.tenantId;

    const [numberRow, settingsRow, tenantRow] = await Promise.all([
      db.query.tenantPhoneNumbers.findFirst({
        where: and(
          eq(tenantPhoneNumbers.tenantId, tenantId),
          eq(tenantPhoneNumbers.status, "active"),
        ),
      }),
      db.query.tenantPhoneSettings.findFirst({
        where: eq(tenantPhoneSettings.tenantId, tenantId),
      }),
      db.query.tenants.findFirst({
        where: eq(tenants.id, tenantId),
        columns: { currentPlan: true },
      }),
    ]);

    // PLAN gate (Pro+). The add-on activation gate is read from settings
    // metadata inside shapeBusinessLineView.
    const planEligible = canUseBusinessLine(getPlan(tenantRow?.currentPlan)).allowed;

    const period = periodForDate(new Date());
    const [usageRow, calls] = await Promise.all([
      db.query.phoneUsageMonthly.findFirst({
        where: and(
          eq(phoneUsageMonthly.tenantId, tenantId),
          eq(phoneUsageMonthly.period, period),
        ),
      }),
      db.query.phoneCallLogs.findMany({
        where: eq(phoneCallLogs.tenantId, tenantId),
        orderBy: [desc(phoneCallLogs.startedAt)],
        limit: RECENT_CALLS_LIMIT,
      }),
    ]);

    const view = shapeBusinessLineView({
      planEligible,
      number: numberRow
        ? {
            phoneNumber: numberRow.phoneNumber,
            status: numberRow.status,
            provisionedAt: numberRow.provisionedAt,
          }
        : null,
      settings: settingsRow
        ? {
            enabled: settingsRow.enabled,
            forwardingNumber: settingsRow.forwardingNumber,
            includedMinutes: settingsRow.includedMinutes,
            monthlyMinuteCap: settingsRow.monthlyMinuteCap,
            metadata: settingsRow.metadata,
          }
        : null,
      usage: usageRow
        ? {
            billableSeconds: usageRow.billableSeconds,
            inboundCalls: usageRow.inboundCalls,
            answeredCalls: usageRow.answeredCalls,
            missedCalls: usageRow.missedCalls,
            estimatedCostCents: usageRow.estimatedCostCents,
          }
        : null,
      recentCalls: calls.map((c) => ({
        id: c.id,
        direction: c.direction,
        fromNumber: c.fromNumber,
        status: c.status,
        startedAt: c.startedAt,
        durationSeconds: c.durationSeconds,
      })),
      period,
    });

    return NextResponse.json(view);
  } catch (err) {
    return errorResponse(err);
  }
}

const patchSchema = z.object({
  // null or "" clears the forwarding number (forwarding target removed).
  forwardingNumber: z.string().max(40).nullable().optional(),
  enabled: z.boolean().optional(),
});

/** PATCH — update forwardingNumber and/or enabled. Validates + normalizes. */
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireRole(["admin"]);
    const tenantId = admin.tenantId;
    const body = patchSchema.parse(await req.json());

    if (body.forwardingNumber === undefined && body.enabled === undefined) {
      throw new HttpError(400, "Nothing to update.");
    }

    // Resolve entitlement (plan gate + add-on flag) and gate the write. When
    // locked, only DISABLING / CLEARING is allowed — never enabling forwarding
    // or setting a forwarding number.
    const [tenantRow, existing] = await Promise.all([
      db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { currentPlan: true } }),
      db.query.tenantPhoneSettings.findFirst({ where: eq(tenantPhoneSettings.tenantId, tenantId) }),
    ]);
    const planEligible = canUseBusinessLine(getPlan(tenantRow?.currentPlan)).allowed;
    const entitlementActive = planEligible && readAddonActiveFlag(existing?.metadata);
    const gate = evaluateBusinessLinePatchGate({
      entitlementActive,
      setsEnabledTrue: body.enabled === true,
      setsNonEmptyForwarding:
        typeof body.forwardingNumber === "string" && body.forwardingNumber.trim() !== "",
    });
    if (!gate.allowed) throw new HttpError(402, gate.reason);

    const patch: Record<string, unknown> = { tenantId, updatedAt: new Date() };

    if (body.forwardingNumber !== undefined) {
      const raw = body.forwardingNumber;
      if (raw === null || raw.trim() === "") {
        // Clearing the forwarding target. (Does not delete the row.)
        patch.forwardingNumber = null;
      } else {
        // Loop guard needs the tenant's own business numbers.
        const owned = await db.query.tenantPhoneNumbers.findMany({
          where: eq(tenantPhoneNumbers.tenantId, tenantId),
          columns: { phoneNumber: true },
        });
        const v = validateForwardingUpdate({
          forwardingNumber: raw,
          ownedNumbers: owned.map((o) => o.phoneNumber),
        });
        if (!v.ok) throw new HttpError(400, forwardingErrorMessage(v.reason));
        patch.forwardingNumber = v.e164;
      }
    }

    if (body.enabled !== undefined) patch.enabled = body.enabled;

    // Upsert the single per-tenant settings row (reuse the `existing` fetched
    // above for the entitlement gate).
    let row;
    if (existing) {
      [row] = await db
        .update(tenantPhoneSettings)
        .set(patch)
        .where(eq(tenantPhoneSettings.tenantId, tenantId))
        .returning();
    } else {
      [row] = await db
        .insert(tenantPhoneSettings)
        .values(patch as typeof tenantPhoneSettings.$inferInsert)
        .returning();
    }

    audit({
      tenantId,
      action: "business_line.settings_updated",
      actorUserId: admin.id,
      actorLabel: admin.email,
      entityType: "business_line_settings",
      entityId: row.id,
      metadata: {
        forwardingChanged: body.forwardingNumber !== undefined,
        enabledChanged: body.enabled !== undefined,
        enabled: row.enabled,
      },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({
      ok: true,
      enabled: row.enabled,
      forwardingNumber: row.forwardingNumber,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
