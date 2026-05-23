/**
 * Wave H Phase 5 — recent webhook events for a provider.
 *
 *   GET /api/tenant/payment-providers/<id>/events?limit=20
 *
 * Returns the most recent N events from tenant_payment_webhook_events,
 * tenant-scoped + provider-scoped. Surfaces the raw_payload +
 * signature_headers added by migration 0052 for forensic inspection.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { tenantPaymentWebhookEvents } from "@/db/schema";
import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { getProviderRedacted } from "@/lib/payments/connections";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["admin"]);
    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) throw new HttpError(404, "Not found");

    // Confirm the caller's tenant owns this provider FIRST. We use
    // getProviderRedacted which ANDs on tenantId — a cross-tenant id
    // returns null and we 404. After that, the events query also ANDs
    // tenantId for defense in depth.
    const provider = await getProviderRedacted(user.tenantId, id);
    if (!provider) throw new HttpError(404, "Not found");

    const limit = Math.max(
      1,
      Math.min(100, Number(req.nextUrl.searchParams.get("limit") ?? "20")),
    );

    const events = await db
      .select({
        id: tenantPaymentWebhookEvents.id,
        externalEventId: tenantPaymentWebhookEvents.externalEventId,
        eventType: tenantPaymentWebhookEvents.eventType,
        status: tenantPaymentWebhookEvents.status,
        error: tenantPaymentWebhookEvents.error,
        bookingId: tenantPaymentWebhookEvents.bookingId,
        receivedAt: tenantPaymentWebhookEvents.receivedAt,
        processingDurationMs: tenantPaymentWebhookEvents.processingDurationMs,
        // raw_payload + signature_headers can be large. We return them
        // here so the inline-expand UI can show them on demand; the
        // page-level fetch returns the LATEST 20 only so payload
        // bloat is bounded.
        rawPayload: tenantPaymentWebhookEvents.rawPayload,
        signatureHeaders: tenantPaymentWebhookEvents.signatureHeaders,
      })
      .from(tenantPaymentWebhookEvents)
      .where(
        and(
          eq(tenantPaymentWebhookEvents.providerId, id),
          eq(tenantPaymentWebhookEvents.tenantId, user.tenantId),
        ),
      )
      .orderBy(desc(tenantPaymentWebhookEvents.receivedAt))
      .limit(limit);

    return NextResponse.json({ events });
  } catch (err) {
    return errorResponse(err);
  }
}
