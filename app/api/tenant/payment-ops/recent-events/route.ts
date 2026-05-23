/**
 * Operational Hardening Wave — recent webhook events feed.
 *
 *   GET /api/tenant/payment-ops/recent-events?limit=20
 *
 * Cross-provider view of recent events for the calling admin's tenant.
 * Returns the lean view (no raw_payload / signature_headers) — those
 * are heavy and the per-provider activity panel in Settings → Payments
 * is the place for the full forensic dive.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantPaymentWebhookEvents } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await requireRole(["admin"]);
    const limit = Math.max(
      1,
      Math.min(100, Number(req.nextUrl.searchParams.get("limit") ?? "20")),
    );

    const events = await db
      .select({
        id: tenantPaymentWebhookEvents.id,
        providerId: tenantPaymentWebhookEvents.providerId,
        provider: tenantPaymentWebhookEvents.provider,
        externalEventId: tenantPaymentWebhookEvents.externalEventId,
        eventType: tenantPaymentWebhookEvents.eventType,
        status: tenantPaymentWebhookEvents.status,
        error: tenantPaymentWebhookEvents.error,
        bookingId: tenantPaymentWebhookEvents.bookingId,
        receivedAt: tenantPaymentWebhookEvents.receivedAt,
        processingDurationMs: tenantPaymentWebhookEvents.processingDurationMs,
      })
      .from(tenantPaymentWebhookEvents)
      .where(eq(tenantPaymentWebhookEvents.tenantId, user.tenantId))
      .orderBy(desc(tenantPaymentWebhookEvents.receivedAt))
      .limit(limit);

    return NextResponse.json({ events });
  } catch (err) {
    return errorResponse(err);
  }
}
