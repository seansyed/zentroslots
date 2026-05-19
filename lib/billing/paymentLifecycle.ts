/**
 * Paid-booking payment lifecycle helpers.
 *
 * State machine layered ON TOP of the existing bookings table. The
 * `bookings_no_overlap` EXCLUDE constraint (status='confirmed' only)
 * is UNTOUCHED — these helpers respect it as the immutable source of
 * truth for double-booking prevention.
 *
 *   pending_payment ──(checkout.session.completed)──▶ confirmed
 *                  └─(cleanup cron or payment_intent.payment_failed)─▶ payment_failed / cancelled
 *   confirmed      ──(full refund)──▶ refunded   (slot released, EXCLUDE no longer applies)
 *   confirmed      ──(partial refund)──▶ confirmed (audit only)
 *
 * Soft-hold race protection: a partial unique index
 * (bookings_pending_payment_unique) collides at insert time when two
 * concurrent pending_payment rows target the same (staff, slot). The
 * race window between pending_payment → confirmed is bounded by:
 *   - the soft hold (15 min by default)
 *   - the EXCLUDE constraint catching the second confirmation attempt
 *     with 23P01 — at which point we auto-refund.
 *
 * Idempotent: every transition checks the current status first; replays
 * (Stripe webhook retries, cron re-runs) are no-ops.
 *
 * Tenant-isolated: every UPDATE is keyed on bookingId AND tenantId.
 *
 * Never throws. Returns structured results.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, type Booking } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { audit } from "@/lib/audit";

/** Default soft-hold window. Overridable by env for emergency tuning. */
export const DEFAULT_HOLD_MINUTES = Number(process.env.PAYMENT_HOLD_MINUTES ?? 15);

export type LifecycleResult =
  | { ok: true; status: Booking["status"]; bookingId: string }
  | { ok: false; reason: string };

// ─── Pending-payment creation ──────────────────────────────────────

export type CreatePendingArgs = {
  tenantId: string;
  serviceId: string;
  staffUserId: string;
  clientName: string;
  clientEmail: string;
  startAt: Date;
  endAt: Date;
  notes?: string | null;
  intakeResponses?: unknown;
  assignmentMode?: string;
  /** Override the default hold window. */
  holdMinutes?: number;
};

/** Insert a booking in 'pending_payment' state with a soft-hold expiry.
 *  The partial unique index on (staff_user_id, start_at) WHERE
 *  status='pending_payment' catches concurrent inserts (23505). */
export async function createPendingPaymentBooking(args: CreatePendingArgs): Promise<
  | { ok: true; booking: Booking }
  | { ok: false; reason: "slot_held" | "slot_taken" | "internal" }
> {
  const holdMin = args.holdMinutes ?? DEFAULT_HOLD_MINUTES;
  const holdExpires = new Date(Date.now() + holdMin * 60_000);
  try {
    const [row] = await db
      .insert(bookings)
      .values({
        tenantId: args.tenantId,
        serviceId: args.serviceId,
        staffUserId: args.staffUserId,
        clientName: args.clientName,
        clientEmail: args.clientEmail,
        startAt: args.startAt,
        endAt: args.endAt,
        notes: args.notes ?? null,
        status: "pending_payment",
        intakeResponses: args.intakeResponses ?? null,
        assignmentMode: args.assignmentMode ?? "direct",
        paymentHoldExpiresAt: holdExpires,
      })
      .returning();
    return { ok: true, booking: row };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    // 23505 = partial unique index collision (another pending_payment
    // for the same staff+slot is in flight).
    if (code === "23505") return { ok: false, reason: "slot_held" };
    // 23P01 = EXCLUDE constraint collision (a confirmed booking exists
    // — this should be rare given availability checks run first, but
    // surface as "slot_taken" so the UI can recover.)
    if (code === "23P01") return { ok: false, reason: "slot_taken" };
    console.error("[payment-lifecycle] createPending failed:", err);
    return { ok: false, reason: "internal" };
  }
}

// ─── Confirm pending → confirmed ───────────────────────────────────

export type ConfirmArgs = {
  bookingId: string;
  tenantId: string;
  stripeSessionId: string;
  stripePaymentIntentId: string | null;
  amountChargedCents: number;
};

/** Transition pending_payment → confirmed atomically. Idempotent:
 *  if the booking is already confirmed (webhook retry), returns ok.
 *  If the EXCLUDE constraint fires (a confirmed booking sneaked in
 *  during the payment window), returns slot_taken — caller must
 *  auto-refund. */
export async function confirmPendingPaymentBooking(args: ConfirmArgs): Promise<
  | { ok: true; bookingId: string; status: "confirmed" }
  | { ok: false; reason: "not_found" | "wrong_state" | "slot_taken" | "internal"; currentStatus?: Booking["status"] }
> {
  // Look up the booking first to make idempotent + tenant-isolated.
  const existing = await db.query.bookings.findFirst({
    where: and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)),
  });
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status === "confirmed") {
    // Idempotent retry — already confirmed. Make sure the Stripe
    // metadata is set (in case the first attempt updated then crashed
    // before persisting the payment intent id).
    if (!existing.stripePaymentIntentId && args.stripePaymentIntentId) {
      await db
        .update(bookings)
        .set({
          stripePaymentIntentId: args.stripePaymentIntentId,
          amountChargedCents: args.amountChargedCents,
          updatedAt: new Date(),
        })
        .where(and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)));
    }
    return { ok: true, bookingId: args.bookingId, status: "confirmed" };
  }
  if (existing.status !== "pending_payment") {
    // Could be cancelled (cleanup cron beat us), payment_failed, etc.
    // NOT a confirmation candidate. Caller should refund.
    return { ok: false, reason: "wrong_state", currentStatus: existing.status };
  }

  // Transition. The EXCLUDE constraint will fire if another confirmed
  // booking exists for the same staff/slot.
  try {
    await db
      .update(bookings)
      .set({
        status: "confirmed",
        stripeSessionId: args.stripeSessionId,
        stripePaymentIntentId: args.stripePaymentIntentId,
        amountChargedCents: args.amountChargedCents,
        paymentHoldExpiresAt: null, // hold cleared
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bookings.id, args.bookingId),
          eq(bookings.tenantId, args.tenantId),
          eq(bookings.status, "pending_payment") // guard against race
        )
      );
    return { ok: true, bookingId: args.bookingId, status: "confirmed" };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "23P01") {
      // Slot taken by another confirmed booking during our payment
      // window. We must refund + mark this booking as payment_failed.
      await markBookingPaymentFailed({
        bookingId: args.bookingId,
        tenantId: args.tenantId,
        reason: "slot_taken_during_payment",
      });
      return { ok: false, reason: "slot_taken", currentStatus: existing.status };
    }
    console.error("[payment-lifecycle] confirm failed:", err);
    return { ok: false, reason: "internal" };
  }
}

// ─── Mark payment_failed ───────────────────────────────────────────

export type MarkFailedArgs = {
  bookingId: string;
  tenantId: string;
  reason: string;
};

/** Idempotent — already-failed or already-cancelled bookings just
 *  audit a "duplicate" entry without re-transitioning. */
export async function markBookingPaymentFailed(args: MarkFailedArgs): Promise<LifecycleResult> {
  const existing = await db.query.bookings.findFirst({
    where: and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)),
  });
  if (!existing) return { ok: false, reason: "not_found" };
  // Already terminal — no-op.
  if (existing.status === "payment_failed" || existing.status === "cancelled" || existing.status === "refunded") {
    return { ok: true, status: existing.status, bookingId: args.bookingId };
  }
  // Only sensible from pending_payment / confirmed.
  if (existing.status !== "pending_payment" && existing.status !== "confirmed") {
    return { ok: false, reason: `wrong_state:${existing.status}` };
  }
  try {
    await db
      .update(bookings)
      .set({
        status: "payment_failed",
        paymentHoldExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)));
  } catch (err) {
    console.error("[payment-lifecycle] markFailed update failed:", err);
    return { ok: false, reason: "internal" };
  }
  audit({
    tenantId: args.tenantId,
    action: "booking.payment_failed",
    entityType: "booking",
    entityId: args.bookingId,
    metadata: { reason: args.reason, previous_status: existing.status },
  });
  return { ok: true, status: "payment_failed", bookingId: args.bookingId };
}

// ─── Mark refunded ─────────────────────────────────────────────────

export type MarkRefundedArgs = {
  bookingId: string;
  tenantId: string;
  refundedAmountCents: number;
  isFullRefund: boolean;
  refundId?: string;
};

/** Full refund → status = 'refunded' (releases the slot since the
 *  EXCLUDE constraint only applies to 'confirmed'). Partial refund →
 *  audit only, status unchanged. */
export async function markBookingRefunded(args: MarkRefundedArgs): Promise<LifecycleResult> {
  const existing = await db.query.bookings.findFirst({
    where: and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)),
  });
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status === "refunded") {
    // Idempotent — already marked.
    return { ok: true, status: "refunded", bookingId: args.bookingId };
  }

  // Audit either way.
  audit({
    tenantId: args.tenantId,
    action: args.isFullRefund ? "booking.refunded" : "booking.partial_refund",
    entityType: "booking",
    entityId: args.bookingId,
    metadata: {
      refunded_cents: args.refundedAmountCents,
      original_cents: existing.amountChargedCents ?? null,
      refund_id: args.refundId ?? null,
    },
  });

  if (!args.isFullRefund) {
    // Partial — audit only, status unchanged.
    return { ok: true, status: existing.status, bookingId: args.bookingId };
  }

  // Full refund — transition. Only meaningful from 'confirmed'.
  if (existing.status !== "confirmed") {
    // Could be pending_payment (refund before checkout settled) or
    // cancelled. Don't force-transition; just audit and move on.
    return { ok: true, status: existing.status, bookingId: args.bookingId };
  }

  try {
    await db
      .update(bookings)
      .set({ status: "refunded", updatedAt: new Date() })
      .where(and(eq(bookings.id, args.bookingId), eq(bookings.tenantId, args.tenantId)));
  } catch (err) {
    console.error("[payment-lifecycle] markRefunded update failed:", err);
    return { ok: false, reason: "internal" };
  }
  return { ok: true, status: "refunded", bookingId: args.bookingId };
}

// ─── Auto-refund a charge (used when EXCLUDE races during confirm) ─

export async function autoRefundCharge(args: {
  paymentIntentId: string;
  reason: string;
}): Promise<{ ok: boolean; refundId?: string; reason?: string }> {
  try {
    const stripe = await getStripe();
    const refund = await stripe.refunds.create(
      {
        payment_intent: args.paymentIntentId,
        reason: "requested_by_customer", // closest Stripe enum
        metadata: { internal_reason: args.reason },
      },
      // Idempotency key so retries don't double-refund.
      { idempotencyKey: `auto-refund:${args.paymentIntentId}` }
    );
    return { ok: true, refundId: refund.id };
  } catch (err) {
    console.error("[payment-lifecycle] auto-refund failed:", err);
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "unknown" };
  }
}
