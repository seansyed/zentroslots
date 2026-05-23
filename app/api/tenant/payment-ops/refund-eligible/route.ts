/**
 * Operational Hardening Wave — refund-eligible bookings list.
 *
 *   GET /api/tenant/payment-ops/refund-eligible?limit=50
 *
 * Returns confirmed Wave H bookings that are refund-eligible:
 *   • status = 'confirmed'
 *   • payment_provider_id IS NOT NULL  (Wave H booking, not legacy)
 *   • stripe_payment_intent_id IS NOT NULL  (charge id available)
 *   • amount_charged_cents > 0
 *
 * Legacy platform-Stripe bookings (payment_provider_id IS NULL) are
 * intentionally excluded — they use the existing refund path.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, services, tenantPaymentProviders } from "@/db/schema";
import { errorResponse, requireRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const user = await requireRole(["admin"]);
    const limit = Math.max(
      1,
      Math.min(200, Number(req.nextUrl.searchParams.get("limit") ?? "50")),
    );

    // Join with services (for the display name) and the provider row
    // (for the display label + mode chip). Both joins are tenant-id
    // bound — defense in depth, the bookings filter already scopes
    // by tenant but joined rows are also tenant-locked.
    const rows = await db
      .select({
        id: bookings.id,
        startAt: bookings.startAt,
        endAt: bookings.endAt,
        clientName: bookings.clientName,
        clientEmail: bookings.clientEmail,
        amountChargedCents: bookings.amountChargedCents,
        stripePaymentIntentId: bookings.stripePaymentIntentId,
        paymentProviderId: bookings.paymentProviderId,
        serviceId: bookings.serviceId,
        serviceName: services.name,
        providerKind: tenantPaymentProviders.provider,
        providerMode: tenantPaymentProviders.mode,
        providerLabel: tenantPaymentProviders.accountLabel,
      })
      .from(bookings)
      .leftJoin(services, eq(services.id, bookings.serviceId))
      .leftJoin(
        tenantPaymentProviders,
        eq(tenantPaymentProviders.id, bookings.paymentProviderId),
      )
      .where(
        and(
          eq(bookings.tenantId, user.tenantId),
          eq(bookings.status, "confirmed"),
          isNotNull(bookings.paymentProviderId),
          isNotNull(bookings.stripePaymentIntentId),
          gt(bookings.amountChargedCents, 0),
        ),
      )
      .orderBy(desc(bookings.updatedAt))
      .limit(limit);

    return NextResponse.json({ bookings: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
