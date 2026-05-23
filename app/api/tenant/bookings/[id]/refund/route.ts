/**
 * Operational Hardening Wave — admin-initiated refund.
 *
 *   POST /api/tenant/bookings/<id>/refund
 *
 * Admin-only. Issues a FULL refund on a confirmed Wave H booking via
 * the provider adapter's refund() — never via direct SDK calls.
 *
 * Refund lifecycle (locked in design doc §2):
 *   1. requireRole(["admin"]) + per-tenant rate limit + UUID validation
 *   2. SELECT booking AND tenant_id — 404 cross-tenant
 *   3. Precondition: status='confirmed' AND payment_provider_id NOT NULL
 *      AND stripe_payment_intent_id NOT NULL AND amount_charged_cents > 0
 *   4. Load provider creds via getProviderWithCredentials (tenant-scoped)
 *   5. Dispatch adapter.refund() — provider-side idempotency via
 *      deterministic key refund:<chargeId>:<bookingId>
 *   6. On success: markBookingRefunded (flips to 'refunded', releases slot)
 *   7. On failure: leave status 'confirmed', audit, return 502 with
 *      redacted error
 *   8. Always audit with actor user id + IP
 *
 * NO new transient 'refunding' state — the existing 'confirmed' status
 * is the precondition, provider idempotency handles in-flight races.
 *
 * Webhook race: if the provider sends a charge.refunded webhook back
 * (it will), the receiver's markBookingRefunded path is idempotent —
 * sees status='refunded' and audits as duplicate without re-flipping.
 */

import { NextRequest, NextResponse } from "next/server";

import { errorResponse, HttpError, requireRole } from "@/lib/auth";
import { ipFromHeaders, audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import {
  getProviderWithCredentials,
} from "@/lib/payments/connections";
import { getAdapter } from "@/lib/payments/registry";
import type { PaymentProviderId } from "@/lib/payments/types";
import { markBookingRefunded } from "@/lib/billing/paymentLifecycle";
import { db } from "@/db/client";
import { bookings } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Runtime kill switch — separate from PHASE3_KILL_SWITCH so an operator
// can disable admin refunds without disabling the whole tenant vault.
function refundDisabled(): boolean {
  const v = process.env.DISABLE_ADMIN_REFUND;
  if (!v) return false;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ip = ipFromHeaders(req.headers) ?? "anon";
  try {
    const user = await requireRole(["admin"]);

    if (refundDisabled()) {
      throw new HttpError(503, "Admin refunds are temporarily disabled");
    }

    // Per-tenant rate limit. Refunds shouldn't be a bulk action;
    // 5/min is generous for legit ops, hostile to scripts/mistakes.
    const rl = rateLimit({
      key: `admin-refund:${user.tenantId}`,
      capacity: 5,
      refillTokens: 5,
      windowMs: 60_000,
    });
    if (!rl.ok) {
      throw new HttpError(429, "Too many refund attempts — try again shortly");
    }

    const { id } = await context.params;
    if (!id || !UUID_RE.test(id)) {
      throw new HttpError(404, "Booking not found");
    }

    // Tenant-scoped read. 404 on cross-tenant — never leaks existence.
    const booking = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.id, id),
        eq(bookings.tenantId, user.tenantId),
      ),
    });
    if (!booking) {
      throw new HttpError(404, "Booking not found");
    }

    // Preconditions — fail-loud with specific 409 messages so the UI
    // can render actionable errors.
    if (booking.status !== "confirmed") {
      throw new HttpError(
        409,
        `Cannot refund: booking is '${booking.status}', not 'confirmed'`,
      );
    }
    if (!booking.paymentProviderId) {
      throw new HttpError(
        409,
        "Cannot refund: this is a legacy platform booking. Use the existing refund tool.",
      );
    }
    if (!booking.stripePaymentIntentId) {
      throw new HttpError(
        409,
        "Cannot refund: no charge id recorded on this booking",
      );
    }
    if (!booking.amountChargedCents || booking.amountChargedCents <= 0) {
      throw new HttpError(409, "Cannot refund: no charge amount recorded");
    }

    // Load creds. The receiver's spoof check (booking.tenantId ===
    // provider.tenantId) is implicit here: getProviderWithCredentials
    // ANDs tenantId — if the booking's provider row was somehow set to
    // a foreign provider, this returns null.
    const loaded = await getProviderWithCredentials(
      user.tenantId,
      booking.paymentProviderId,
    );
    if (!loaded) {
      throw new HttpError(
        410,
        "Payment provider has been removed — cannot issue refund",
      );
    }

    const adapter = getAdapter(loaded.row.provider as PaymentProviderId);

    // Dispatch the refund. The adapter handles provider-side idempotency
    // via deterministic key refund:<chargeId>:<bookingId>. Same booking
    // refunded twice within the provider's idempotency window returns
    // the same refund id, not a duplicate charge reversal.
    let refundResult;
    try {
      refundResult = await adapter.refund(loaded.creds, {
        externalChargeId: booking.stripePaymentIntentId,
        bookingId: booking.id,
        amountCents: null, // full refund (this wave's scope)
        reason: "admin_initiated_refund",
      });
    } catch (err) {
      // Adapter contract says it never throws — but defense in depth.
      const message = err instanceof Error ? err.message.slice(0, 200) : "unknown";
      audit({
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "booking.payment.admin_refund_failed",
        entityType: "booking",
        entityId: booking.id,
        metadata: {
          providerId: booking.paymentProviderId,
          chargeId: booking.stripePaymentIntentId,
          amountCents: booking.amountChargedCents,
          reason: "adapter_threw",
          message,
        },
        ipAddress: ip === "anon" ? null : ip,
      });
      throw new HttpError(502, "Payment provider unavailable — try again shortly");
    }

    // Audit BEFORE the state change so a crash after refund-but-before-
    // update still leaves a trail. (The webhook will eventually arrive
    // and flip the booking via the existing markBookingRefunded path,
    // so no data is permanently lost.)
    audit({
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: refundResult.ok
        ? "booking.payment.admin_refund_initiated"
        : "booking.payment.admin_refund_failed",
      entityType: "booking",
      entityId: booking.id,
      metadata: {
        providerId: booking.paymentProviderId,
        provider: loaded.row.provider,
        chargeId: booking.stripePaymentIntentId,
        amountCents: booking.amountChargedCents,
        refundId: refundResult.ok ? refundResult.refundId : undefined,
        errorClass: refundResult.ok ? undefined : refundResult.errorClass,
        message: refundResult.ok ? undefined : refundResult.reason,
      },
      ipAddress: ip === "anon" ? null : ip,
    });

    if (!refundResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          reason: refundResult.reason,
          errorClass: refundResult.errorClass,
        },
        { status: 502 },
      );
    }

    // Refund issued. Flip booking → 'refunded' (this releases the
    // slot via the EXCLUDE constraint — intentional, a refunded
    // booking should free the timeslot). markBookingRefunded is
    // idempotent: an already-'refunded' booking is a no-op.
    const mark = await markBookingRefunded({
      bookingId: booking.id,
      tenantId: user.tenantId,
      refundedAmountCents: booking.amountChargedCents,
      isFullRefund: true,
      refundId: refundResult.refundId,
    });
    if (!mark.ok) {
      // The refund SUCCEEDED at the provider but our DB update failed.
      // Don't show this as a refund failure to the admin — money DID
      // move. The forthcoming webhook will reconcile.
      audit({
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "booking.payment.admin_refund_status_update_failed",
        entityType: "booking",
        entityId: booking.id,
        metadata: {
          refundId: refundResult.refundId,
          reason: mark.reason,
        },
        ipAddress: ip === "anon" ? null : ip,
      });
    }

    return NextResponse.json({
      ok: true,
      refundId: refundResult.refundId,
      amountRefunded: booking.amountChargedCents,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
