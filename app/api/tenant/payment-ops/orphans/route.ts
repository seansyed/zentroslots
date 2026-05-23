/**
 * Operational Hardening Wave — orphan webhook events.
 *
 *   GET /api/tenant/payment-ops/orphans?limit=20
 *
 * Returns events that landed in our webhook table but couldn't be
 * attached to a booking. Surfaces for manual review per the Phase 3
 * Decision-4 orphan policy. Operators can:
 *   • Investigate the provider-side event to find the real booking
 *   • Issue a manual refund via the provider's own dashboard
 *   • Update booking metadata if a legit booking is found
 *
 * NEVER auto-acts. Decision 4 (locked): manual review only.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, isNull, or } from "drizzle-orm";

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

    // Orphan = unhandled with no booking_id resolved. We could also
    // include 'invalid_signature' here but those are security-class
    // events surfaced separately in the activity feed.
    const events = await db
      .select({
        id: tenantPaymentWebhookEvents.id,
        providerId: tenantPaymentWebhookEvents.providerId,
        provider: tenantPaymentWebhookEvents.provider,
        externalEventId: tenantPaymentWebhookEvents.externalEventId,
        eventType: tenantPaymentWebhookEvents.eventType,
        status: tenantPaymentWebhookEvents.status,
        error: tenantPaymentWebhookEvents.error,
        receivedAt: tenantPaymentWebhookEvents.receivedAt,
      })
      .from(tenantPaymentWebhookEvents)
      .where(
        and(
          eq(tenantPaymentWebhookEvents.tenantId, user.tenantId),
          isNull(tenantPaymentWebhookEvents.bookingId),
          or(
            eq(tenantPaymentWebhookEvents.status, "unhandled"),
            eq(tenantPaymentWebhookEvents.status, "orphan"),
          ),
        ),
      )
      .orderBy(desc(tenantPaymentWebhookEvents.receivedAt))
      .limit(limit);

    return NextResponse.json({ events });
  } catch (err) {
    return errorResponse(err);
  }
}
