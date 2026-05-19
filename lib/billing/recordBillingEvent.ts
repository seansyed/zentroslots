/**
 * Stripe webhook → billing_transactions translator.
 *
 * Called from app/api/webhooks/stripe/route.ts for the four
 * revenue-relevant event types:
 *   - invoice.payment_succeeded
 *   - payment_intent.succeeded
 *   - charge.refunded
 *   - invoice.payment_failed
 *
 * Idempotency:
 *   1. We pass `event.id` as `stripe_event_id`; the partial unique
 *      index on that column gates duplicates. 23505 → swallow silently.
 *   2. For events that reference a PaymentIntent, the partial unique
 *      on `stripe_payment_intent_id` (limited to paid-type rows) also
 *      catches cross-event-type duplicates.
 *
 * Tenant resolution:
 *   Stripe's customer id maps to one tenant via `tenants.stripeCustomerId`.
 *   If we can't resolve the tenant (e.g. event for a customer that
 *   doesn't exist in our DB anymore), we LOG and skip rather than
 *   creating an orphaned ledger row.
 *
 * NEVER throws to the caller — webhook handler stays clean. Returns
 * a structured result so the handler can log outcomes.
 */
import type Stripe from "stripe";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { billingTransactions, tenants } from "@/db/schema";

export type RecordResult =
  | { ok: true; status: "inserted"; id: string }
  | { ok: true; status: "skipped"; reason: string }
  | { ok: false; reason: string };

export async function recordBillingEvent(event: Stripe.Event): Promise<RecordResult> {
  try {
    // We pre-detect the relevant subset to avoid pulling fields off
    // unrelated event objects. Anything else exits clean.
    switch (event.type) {
      case "invoice.payment_succeeded":
        return await recordInvoicePaid(event);
      case "invoice.payment_failed":
        return await recordInvoiceFailed(event);
      case "payment_intent.succeeded":
        return await recordPaymentIntentSucceeded(event);
      case "charge.refunded":
        return await recordChargeRefunded(event);
      default:
        return { ok: true, status: "skipped", reason: "event_not_revenue_relevant" };
    }
  } catch (e) {
    // Last-resort safety. The handler swallows this too; we just want
    // a structured log line.
    console.error("[billing] recordBillingEvent crash:", e);
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
  }
}

// ─── Per-event handlers ────────────────────────────────────────────────

async function recordInvoicePaid(event: Stripe.Event): Promise<RecordResult> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = stringCustomer(invoice.customer);
  const tenant = customerId ? await resolveTenant(customerId) : null;
  if (!tenant) return { ok: true, status: "skipped", reason: "tenant_not_found" };

  const amount = invoice.amount_paid ?? 0;
  if (typeof amount !== "number" || amount <= 0) {
    return { ok: true, status: "skipped", reason: "no_amount" };
  }

  // Invoice payment is either a subscription_payment (subscription
  // present) or a one-off invoice_payment. The Stripe SDK type for
  // `subscription` / `payment_intent` varies across versions — read
  // through a defensive narrowing.
  const invoiceExtras = invoice as unknown as {
    subscription?: string | Stripe.Subscription | null;
    payment_intent?: string | Stripe.PaymentIntent | null;
  };
  const isSub = Boolean(invoiceExtras.subscription);
  const pi = stringPi(invoiceExtras.payment_intent);

  return await safeInsert({
    tenantId: tenant.id,
    stripeEventId: event.id,
    stripeInvoiceId: typeof invoice.id === "string" ? invoice.id : null,
    stripePaymentIntentId: pi,
    stripeCustomerId: customerId,
    amountCents: amount,
    currency: invoice.currency ?? "usd",
    transactionType: isSub ? "subscription_payment" : "invoice_payment",
    status: "paid",
    paidAt: new Date(),
    metadata: {
      stripe_invoice_number: typeof invoice.number === "string" ? invoice.number : null,
    },
  });
}

async function recordInvoiceFailed(event: Stripe.Event): Promise<RecordResult> {
  const invoice = event.data.object as Stripe.Invoice;
  const customerId = stringCustomer(invoice.customer);
  const tenant = customerId ? await resolveTenant(customerId) : null;
  if (!tenant) return { ok: true, status: "skipped", reason: "tenant_not_found" };

  const amount = invoice.amount_due ?? 0;
  if (typeof amount !== "number" || amount <= 0) {
    return { ok: true, status: "skipped", reason: "no_amount" };
  }

  const invoiceExtras = invoice as unknown as {
    subscription?: string | Stripe.Subscription | null;
    payment_intent?: string | Stripe.PaymentIntent | null;
  };
  const pi = stringPi(invoiceExtras.payment_intent);

  return await safeInsert({
    tenantId: tenant.id,
    stripeEventId: event.id,
    stripeInvoiceId: typeof invoice.id === "string" ? invoice.id : null,
    stripePaymentIntentId: pi,
    stripeCustomerId: customerId,
    amountCents: amount,
    currency: invoice.currency ?? "usd",
    transactionType: invoiceExtras.subscription ? "subscription_payment" : "invoice_payment",
    status: "failed",
    paidAt: null,
    metadata: {
      attempt_count: typeof invoice.attempt_count === "number" ? invoice.attempt_count : null,
    },
  });
}

async function recordPaymentIntentSucceeded(event: Stripe.Event): Promise<RecordResult> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const piExtras = pi as unknown as { invoice?: string | Stripe.Invoice | null };
  // Skip PIs that belong to an invoice — invoice.payment_succeeded
  // is the canonical event for those. The PI-only path covers
  // standalone payments (booking payments using direct PaymentIntent
  // confirmations).
  if (piExtras.invoice) {
    return { ok: true, status: "skipped", reason: "covered_by_invoice_event" };
  }
  const customerId = stringCustomer(pi.customer);
  const tenant = customerId ? await resolveTenant(customerId) : null;
  if (!tenant) return { ok: true, status: "skipped", reason: "tenant_not_found" };

  const amount = pi.amount_received ?? pi.amount ?? 0;
  if (typeof amount !== "number" || amount <= 0) {
    return { ok: true, status: "skipped", reason: "no_amount" };
  }

  // Booking id round-trip via PI metadata if the caller set it.
  const bookingId = typeof pi.metadata?.bookingId === "string" ? pi.metadata.bookingId : null;

  return await safeInsert({
    tenantId: tenant.id,
    stripeEventId: event.id,
    stripeInvoiceId: null,
    stripePaymentIntentId: pi.id,
    stripeCustomerId: customerId,
    bookingId,
    amountCents: amount,
    currency: pi.currency ?? "usd",
    transactionType: "booking_payment",
    status: "paid",
    paidAt: new Date(),
    metadata: {},
  });
}

async function recordChargeRefunded(event: Stripe.Event): Promise<RecordResult> {
  const charge = event.data.object as Stripe.Charge;
  const customerId = stringCustomer(charge.customer);
  const tenant = customerId ? await resolveTenant(customerId) : null;
  if (!tenant) return { ok: true, status: "skipped", reason: "tenant_not_found" };

  const refunded = charge.amount_refunded ?? 0;
  if (typeof refunded !== "number" || refunded <= 0) {
    return { ok: true, status: "skipped", reason: "no_refund_amount" };
  }

  // We INSERT a new 'refund' row (negative amount). The original
  // 'paid' row stays as-is for audit (Stripe charge.refunded does NOT
  // mean a status flip on the original payment — only that some
  // amount was returned). If the refund is full, we also flip the
  // original row's status — best-effort, never throws.
  const chargeExtras = charge as unknown as {
    payment_intent?: string | Stripe.PaymentIntent | null;
    invoice?: string | Stripe.Invoice | null;
  };
  const pi = stringPi(chargeExtras.payment_intent);
  const fullyRefunded = (charge.amount ?? 0) === refunded;

  const refundInsert = await safeInsert({
    tenantId: tenant.id,
    stripeEventId: event.id,
    stripeInvoiceId: typeof chargeExtras.invoice === "string" ? chargeExtras.invoice : null,
    stripePaymentIntentId: null, // refund row keeps PI off the unique index
    stripeCustomerId: customerId,
    amountCents: -refunded,
    currency: charge.currency ?? "usd",
    transactionType: "refund",
    status: "refunded",
    paidAt: null,
    refundedAt: new Date(),
    metadata: {
      original_charge_id: charge.id ?? null,
      original_payment_intent: pi,
      fully_refunded: fullyRefunded,
    },
  });

  // If a matching original 'paid' row exists for the same PI, flip
  // it to 'refunded' / 'partially_refunded' for accurate dashboard
  // status counts. Best-effort.
  if (pi) {
    try {
      const newStatus = fullyRefunded ? "refunded" : "partially_refunded";
      await db
        .update(billingTransactions)
        .set({
          status: newStatus,
          refundedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(billingTransactions.stripePaymentIntentId, pi));
    } catch (e) {
      console.error("[billing] failed to flip original paid row status:", e);
      // Refund row still inserted; dashboard math handles negative
      // amounts correctly even if the original status isn't flipped.
    }
  }

  return refundInsert;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function stringCustomer(c: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!c) return null;
  if (typeof c === "string") return c;
  return c.id ?? null;
}

function stringPi(p: string | Stripe.PaymentIntent | null | undefined): string | null {
  if (!p) return null;
  if (typeof p === "string") return p;
  return p.id ?? null;
}

async function resolveTenant(stripeCustomerId: string): Promise<{ id: string } | null> {
  const row = await db.query.tenants.findFirst({
    where: eq(tenants.stripeCustomerId, stripeCustomerId),
  });
  return row ? { id: row.id } : null;
}

type InsertArgs = {
  tenantId: string;
  stripeEventId: string | null;
  stripeInvoiceId: string | null;
  stripePaymentIntentId: string | null;
  stripeCustomerId: string | null;
  customerId?: string | null;
  bookingId?: string | null;
  subscriptionId?: string | null;
  amountCents: number;
  currency: string;
  transactionType: string;
  status: string;
  paidAt: Date | null;
  refundedAt?: Date | null;
  metadata: Record<string, unknown>;
};

async function safeInsert(args: InsertArgs): Promise<RecordResult> {
  try {
    const [row] = await db
      .insert(billingTransactions)
      .values({
        tenantId: args.tenantId,
        stripeEventId: args.stripeEventId,
        stripeInvoiceId: args.stripeInvoiceId,
        stripePaymentIntentId: args.stripePaymentIntentId,
        stripeCustomerId: args.stripeCustomerId,
        customerId: args.customerId ?? null,
        bookingId: args.bookingId ?? null,
        subscriptionId: args.subscriptionId ?? null,
        amountCents: args.amountCents,
        currency: args.currency,
        transactionType: args.transactionType,
        status: args.status,
        paidAt: args.paidAt,
        refundedAt: args.refundedAt ?? null,
        metadata: args.metadata,
      })
      .returning({ id: billingTransactions.id });
    return { ok: true, status: "inserted", id: row.id };
  } catch (e: unknown) {
    // 23505 = unique-violation. Stripe retry / our re-delivery.
    // Treat as benign idempotency hit.
    if ((e as { code?: string })?.code === "23505") {
      return { ok: true, status: "skipped", reason: "already_recorded" };
    }
    console.error("[billing] insert failed:", e);
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
  }
}
