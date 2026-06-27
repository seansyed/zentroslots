import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client";
import { tenantPhoneNumbers, phoneUsageMonthly, phoneCallLogs, customers } from "@/db/schema";
import { errorResponse, requireRole, HttpError } from "@/lib/auth";
import { audit, ipFromHeaders } from "@/lib/audit";
import { secondsToBillableMinutes } from "@/lib/business-line";
import { periodForDate } from "@/lib/business-line-view";
import {
  readBusinessLineConfig,
  buildBridgeCallbackUrl,
} from "@/lib/telnyx-business-line";
import {
  decideOutboundBridge,
  bridgeRejectToHttp,
  signBridgeToken,
  normalizeCallPurpose,
  STAFF_RING_TIMEOUT_SECONDS,
  DEFAULT_MAX_CONCURRENT_OUTBOUND,
  type OutboundBridgeContext,
} from "@/lib/business-line-bridge";
import { getTenantBusinessPhone, getStaffPhone } from "@/lib/business-phone-access";
import { canOriginate, originateBridgeCall } from "@/lib/telnyx-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tenant/phone/calls — place an OUTBOUND BRIDGE call (Business Phone
 * Phase 1). ZentroMeet rings the STAFF phone first (P1.1: the caller's own
 * bridge number, falling back to the tenant forwarding number); when it answers,
 * the bridge webhook dials the customer with the tenant business number as
 * caller ID. The staff's personal number is NEVER presented to the customer.
 *
 * Fully fail-closed + entitlement-gated:
 *   - admin/manager/staff (staff are gated by their own can_place_calls in the
 *     decision below — an unpermitted staff member is rejected staff_disabled);
 *   - requires the business_line capability (Pro+) AND the active add-on (402);
 *   - resolves the staff leg (staff → tenant fallback → setup_required) and
 *     refuses a disabled staff member;
 *   - validates US/CA destination, blocks emergency/N11, international,
 *     self-call, staff-loop; enforces monthly cap + concurrency;
 *   - places the Telnyx leg ONLY when the flag is on and the API key + TeXML app
 *     id are configured (canOriginate). With the flag OFF — the default for every
 *     tenant except the pilot — this returns 503 and NO Telnyx call is made and
 *     NO row is written.
 */

const bodySchema = z
  .object({
    toNumber: z.string().trim().min(1).max(40).optional(),
    customerId: z.string().uuid().optional(),
    callPurpose: z.enum(["new_call", "callback_missed", "customer_call"]).optional(),
  })
  .refine((b) => Boolean(b.toNumber) || Boolean(b.customerId), {
    message: "Provide a phone number or a customer.",
  });

export async function POST(req: NextRequest) {
  try {
    const user = await requireRole(["admin", "manager", "staff"]);
    const tenantId = user.tenantId;
    const body = bodySchema.parse(await req.json());
    const callPurpose = normalizeCallPurpose(body.callPurpose) ?? "new_call";

    // Resolve the destination. A customerId (tenant-scoped) resolves to that
    // customer's phone; otherwise the raw toNumber is used. We re-validate the
    // number inside decideOutboundBridge — fail-closed.
    let destinationRaw: string | null = body.toNumber?.trim() ?? null;
    let customerId: string | null = null;
    if (body.customerId) {
      const customer = await db.query.customers.findFirst({
        where: and(eq(customers.id, body.customerId), eq(customers.tenantId, tenantId)),
        columns: { id: true, phone: true },
      });
      if (!customer) throw new HttpError(404, "Customer not found.");
      if (!customer.phone || customer.phone.trim() === "") {
        throw new HttpError(400, "That customer has no phone number on file.");
      }
      customerId = customer.id;
      destinationRaw = customer.phone;
    }

    const period = periodForDate(new Date());
    const [bp, staff, usage, active, activeNumberRow] = await Promise.all([
      getTenantBusinessPhone(tenantId),
      getStaffPhone(tenantId, user.id),
      db.query.phoneUsageMonthly.findFirst({
        where: and(eq(phoneUsageMonthly.tenantId, tenantId), eq(phoneUsageMonthly.period, period)),
      }),
      db.query.phoneCallLogs.findMany({
        where: and(
          eq(phoneCallLogs.tenantId, tenantId),
          eq(phoneCallLogs.direction, "outbound"),
          inArray(phoneCallLogs.status, ["ringing", "answered"]),
        ),
        columns: { id: true },
      }),
      db.query.tenantPhoneNumbers.findFirst({
        where: and(eq(tenantPhoneNumbers.tenantId, tenantId), eq(tenantPhoneNumbers.status, "active")),
        columns: { id: true },
      }),
    ]);

    const ctx: OutboundBridgeContext = {
      businessNumber: bp.businessNumber,
      ownedNumbers: bp.ownedNumbers,
      settingsEnabled: bp.settingsEnabled,
      entitlementActive: bp.entitled,
      // P1.1: prefer the staff member's own bridge phone; fall back to the tenant
      // forwarding number (pilot compatibility); a disabled staff is rejected.
      staffRowExists: Boolean(staff),
      staffEnabled: staff?.enabled ?? false,
      staffCanPlaceCalls: staff?.canPlaceCalls ?? false,
      staffBridgeNumber: staff?.bridgePhoneNumber ?? null,
      tenantFallbackNumber: bp.forwardingNumber,
      destinationRaw,
      minutesUsed: secondsToBillableMinutes(usage?.billableSeconds ?? 0),
      monthlyMinuteCap: bp.monthlyMinuteCap,
      activeOutboundCalls: active.length,
      maxConcurrentCalls: DEFAULT_MAX_CONCURRENT_OUTBOUND,
    };

    const decision = decideOutboundBridge(ctx);
    if (decision.action === "reject") {
      const mapped = bridgeRejectToHttp(decision.reason);
      throw new HttpError(mapped.status, mapped.message);
    }

    // Past every gate. Place the leg ONLY when the engine is enabled + configured.
    // (This is the hard guarantee that no real call happens with the flag OFF.)
    const config = readBusinessLineConfig();
    if (!canOriginate(config)) {
      throw new HttpError(503, "Business Phone calling is temporarily unavailable.");
    }
    const appBaseUrl = (process.env.APP_BASE_URL ?? "").replace(/\/+$/, "");
    if (!appBaseUrl) {
      throw new HttpError(503, "Business Phone calling is temporarily unavailable.");
    }

    // The customer + caller ID travel in the bridge URL, integrity-bound by an
    // HMAC token (the body, separately, is Ed25519-verified by Telnyx).
    const token = signBridgeToken(config.apiKey ?? "", decision.customerNumber, decision.callerId);
    const bridgeUrl =
      `${buildBridgeCallbackUrl(appBaseUrl)}?` +
      new URLSearchParams({ to: decision.customerNumber, cid: decision.callerId, t: token }).toString();

    // No per-call StatusCallback — outbound status is reported via the TeXML
    // app's configured status_callback (Ed25519-signed) → /voice/status, the
    // same verified path as inbound. (P1.x signature fix.)
    const result = await originateBridgeCall({
      config,
      to: decision.staffNumber,
      from: decision.callerId,
      bridgeUrl,
      ringTimeoutSeconds: STAFF_RING_TIMEOUT_SECONDS,
    });
    if (!result.ok) {
      console.error(`[phone/calls] originate failed (${result.reason}):`, result.detail ?? "");
      throw new HttpError(502, "Couldn't place the call right now. Please try again.");
    }

    // Log the outbound call (idempotent on the Telnyx session id, when present).
    const [row] = await db
      .insert(phoneCallLogs)
      .values({
        tenantId,
        phoneNumberId: activeNumberRow?.id ?? null,
        direction: "outbound",
        fromNumber: decision.callerId, // business number (what the customer sees)
        toNumber: decision.customerNumber, // the customer dialed
        forwardedToNumber: decision.staffNumber, // the staff leg we rang first
        status: "ringing",
        startedAt: new Date(),
        placedByUserId: user.id,
        customerId,
        callPurpose,
        // Correlate status callbacks by the call id Telnyx returns. TeXML status
        // callbacks carry `CallSid`, which equals the originate response's
        // top-level `sid`; store that (falling back to an explicit session id).
        telnyxCallSessionId: result.callSessionId ?? result.callSid,
        telnyxCallControlId: result.callSid,
      } as typeof phoneCallLogs.$inferInsert)
      .returning({ id: phoneCallLogs.id });

    audit({
      tenantId,
      action: "business_phone.call_initiated",
      actorUserId: user.id,
      actorLabel: user.email,
      entityType: "phone_call",
      entityId: row?.id,
      metadata: { callPurpose, hasCustomer: Boolean(customerId), staffSource: decision.staffSource },
      ipAddress: ipFromHeaders(req.headers),
    });

    return NextResponse.json({
      ok: true,
      callId: row?.id ?? null,
      status: "ringing",
      callerId: decision.callerId,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
