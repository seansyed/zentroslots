import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { bookings, tenants } from "@/db/schema";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import { recordBillingEvent } from "@/lib/billing/recordBillingEvent";
import {
  autoRefundCharge,
  confirmPendingPaymentBooking,
  markBookingPaymentFailed,
  markBookingRefunded,
} from "@/lib/billing/paymentLifecycle";
import { runPostConfirmationHooks } from "@/lib/billing/postBookingHooks";

// Use Node runtime so we can read the raw body for signature verification.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function planFromPriceId(priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  if (process.env.STRIPE_PRICE_PRO && priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (process.env.STRIPE_PRICE_TEAM && priceId === process.env.STRIPE_PRICE_TEAM) return "team";
  return null;
}

export async function POST(req: NextRequest) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, { status: 500 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });

  const stripe = await getStripe();
  const raw = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // ─── Billing ledger (additive) ──────────────────────────────────────
  // Recording is invoked BEFORE the existing switch so retries land
  // even if a downstream handler errors. The helper NEVER throws —
  // it returns a structured result and logs internally. Existing
  // handler behavior below is preserved exactly.
  try {
    const result = await recordBillingEvent(event);
    if (!result.ok) {
      console.warn(`[billing] event ${event.id} not recorded:`, result.reason);
    }
  } catch (ledgerErr) {
    // Defense-in-depth — record helper already wraps everything but
    // we double-guard here. Webhook MUST not 500 due to ledger writes.
    console.error("[billing] ledger crashed (webhook unaffected):", ledgerErr);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        // ── Paid-booking branch (0030, additive). Discriminate on
        //    metadata.kind = 'booking_payment'. SUBSCRIPTION flow
        //    below stays byte-identical for kind !== 'booking_payment'.
        const kind = (session.metadata?.kind as string | undefined) ?? null;
        if (kind === "booking_payment") {
          const bookingId = (session.metadata?.booking_id as string | undefined) ?? null;
          const bookingTenantId = (session.metadata?.tenant_id as string | undefined) ?? null;
          if (bookingId && bookingTenantId) {
            const paymentIntentId =
              typeof session.payment_intent === "string" ? session.payment_intent : null;
            const amountCents = Number(session.amount_total ?? 0);
            const confirmResult = await confirmPendingPaymentBooking({
              bookingId,
              tenantId: bookingTenantId,
              stripeSessionId: session.id,
              stripePaymentIntentId: paymentIntentId,
              amountChargedCents: amountCents,
            });
            if (confirmResult.ok) {
              // Fire the post-confirmation hooks (calendar, email, etc.).
              await runPostConfirmationHooks({
                bookingId,
                tenantId: bookingTenantId,
              });
            } else if (confirmResult.reason === "slot_taken" && paymentIntentId) {
              // EXCLUDE race: a confirmed booking sneaked in during
              // the payment window. Auto-refund + the lifecycle
              // helper already marked our booking as payment_failed.
              await autoRefundCharge({
                paymentIntentId,
                reason: "slot_taken_during_payment",
              });
            }
            // Other failure reasons (wrong_state, not_found) are
            // logged inside the helper; webhook returns 200 either
            // way so Stripe doesn't retry.
          }
          break;
        }

        // ── SUBSCRIPTION branch (existing, unchanged) ──
        const tenantId = (session.metadata?.tenantId as string | undefined) ?? null;
        const plan = (session.metadata?.plan as string | undefined) ?? null;
        if (tenantId) {
          await db
            .update(tenants)
            .set({
              stripeCustomerId: (session.customer as string) ?? null,
              stripeSubscriptionId: (session.subscription as string) ?? null,
              subscriptionStatus: "active",
              currentPlan: plan ?? "pro",
              updatedAt: new Date(),
            })
            .where(eq(tenants.id, tenantId));
        }
        break;
      }

      case "payment_intent.payment_failed": {
        // ── Paid-booking failure (0030, additive). Find the booking
        //    by stripe_payment_intent_id OR by metadata.booking_id
        //    that we set on session creation.
        const pi = event.data.object;
        const piId = pi.id;
        const bookingId = (pi.metadata?.booking_id as string | undefined) ?? null;
        const bookingTenantId = (pi.metadata?.tenant_id as string | undefined) ?? null;
        let resolvedBookingId: string | null = bookingId;
        let resolvedTenantId: string | null = bookingTenantId;
        if (!resolvedBookingId && piId) {
          // Fallback: look up by stripe_payment_intent_id.
          const row = await db.query.bookings.findFirst({
            where: eq(bookings.stripePaymentIntentId, piId),
          });
          if (row) {
            resolvedBookingId = row.id;
            resolvedTenantId = row.tenantId;
          }
        }
        if (resolvedBookingId && resolvedTenantId) {
          await markBookingPaymentFailed({
            bookingId: resolvedBookingId,
            tenantId: resolvedTenantId,
            reason: pi.last_payment_error?.message?.slice(0, 200) ?? "payment_failed",
          });
        }
        break;
      }

      case "charge.refunded": {
        // ── Full or partial refund sync (0030, additive). Stripe
        //    charge.refunded fires on EVERY refund including partials.
        //    We discriminate by amount_refunded vs amount on the charge.
        const charge = event.data.object;
        const piId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null;
        if (piId) {
          const row = await db.query.bookings.findFirst({
            where: eq(bookings.stripePaymentIntentId, piId),
          });
          if (row) {
            const isFullRefund = (charge.amount_refunded ?? 0) >= (charge.amount ?? 0);
            await markBookingRefunded({
              bookingId: row.id,
              tenantId: row.tenantId,
              refundedAmountCents: charge.amount_refunded ?? 0,
              isFullRefund,
              // Most recent refund id when available.
              refundId: charge.refunds?.data?.[0]?.id ?? undefined,
            });
          }
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const sub = event.data.object;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const planLabel = planFromPriceId(priceId);
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;

        await db
          .update(tenants)
          .set({
            stripeSubscriptionId: sub.id,
            subscriptionStatus: sub.status,
            currentPlan: planLabel ?? undefined,
            trialEnd,
            updatedAt: new Date(),
          })
          .where(eq(tenants.stripeCustomerId, customerId));
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await db
          .update(tenants)
          .set({
            stripeSubscriptionId: null,
            subscriptionStatus: "canceled",
            currentPlan: "free",
            updatedAt: new Date(),
          })
          .where(eq(tenants.stripeCustomerId, customerId));
        break;
      }

      default:
        // Ignore other events for MVP — Stripe is happy with a 200.
        break;
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook handler error:", err);
    return NextResponse.json({ error: "handler failed" }, { status: 500 });
  }
}
