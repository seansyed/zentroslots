/**
 * Wave H Phase 3 — booking-lifecycle orchestrator for the tenant
 * payment vault.
 *
 * This module is the ONLY caller of `getProviderWithCredentials` for the
 * booking-creation + webhook-confirmation paths. It encapsulates:
 *   • Route resolution (which provider does THIS booking go through?)
 *   • Strict no-provider behavior (503 — never silent fallback)
 *   • Checkout creation with adapter dispatch
 *   • Pending-payment row insertion with `payment_provider_id` stamped
 *   • Confirm-or-refund flow with the slot-race ordering invariant:
 *       refund FIRST → release hold → mark orphan/manual-review
 *
 * Tenant isolation: every helper takes tenantId AND providerId; the
 * cred-fetch helper ANDs both in the WHERE clause (defense in depth).
 *
 * Never throws on adapter/provider errors. Returns structured results
 * so the booking POST + webhook receiver can decide HTTP status.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bookings,
  tenantPaymentProviders,
  tenants,
  type Booking,
  type TenantPaymentProvider,
} from "@/db/schema";
import { audit } from "@/lib/audit";
import {
  getDefaultProviderRedacted,
  getProviderWithCredentials,
  recordWebhookSuccess,
  type RedactedProviderRow,
} from "@/lib/payments/connections";
import { getAdapter } from "@/lib/payments/registry";
import type {
  CheckoutResult,
  PaymentMode,
  PaymentProviderId,
  ProviderCredentials,
  RefundResult,
} from "@/lib/payments/types";
import {
  confirmPendingPaymentBooking,
  createPendingPaymentBooking,
  markBookingPaymentFailed,
  type CreatePendingArgs,
} from "@/lib/billing/paymentLifecycle";

// ─── Kill switch + flag resolution ─────────────────────────────────────
//
// Runtime-evaluated, NEVER memoized. process.env is read on every call
// so a hot operator change (`vi .env && pm2 restart`) takes effect on the
// next request without a rebuild. The constant from .env can be flipped
// at runtime via `pm2 set scheduling-saas:PHASE3_KILL_SWITCH true && pm2
// restart scheduling-saas --update-env` — ~3s rollout.

function killSwitchActive(): boolean {
  const v = process.env.PHASE3_KILL_SWITCH;
  if (!v) return false;
  // Truthy values: '1', 'true', 'yes', 'on'. Anything else = off.
  return /^(1|true|yes|on)$/i.test(v.trim());
}

// ─── Route resolution ──────────────────────────────────────────────────

export type RouteResolution =
  | { kind: "tenant_vault"; provider: RedactedProviderRow }
  | { kind: "legacy_platform" }
  | { kind: "strict_no_provider"; tenantId: string };

/**
 * Decide which payment path a paid booking should take.
 *
 *   killSwitchActive               → legacy_platform (operator panic)
 *   tenant.use_tenant_payment_providers = false → legacy_platform
 *   flag=true + default provider configured     → tenant_vault
 *   flag=true + no default                      → strict_no_provider (503)
 *
 * Always strict on missing-provider per Decision 1 — we never silently
 * fall back to the platform Stripe key when the tenant opted in.
 */
export async function resolveTenantVaultRoute(args: {
  tenantId: string;
  mode?: PaymentMode; // defaults to 'live'
}): Promise<RouteResolution> {
  if (killSwitchActive()) {
    return { kind: "legacy_platform" };
  }
  const tenant = await db.query.tenants.findFirst({
    where: eq(tenants.id, args.tenantId),
    columns: { useTenantPaymentProviders: true },
  });
  if (!tenant || !tenant.useTenantPaymentProviders) {
    return { kind: "legacy_platform" };
  }
  const mode = args.mode ?? "live";
  const provider = await getDefaultProviderRedacted(args.tenantId, mode);
  if (!provider) {
    return { kind: "strict_no_provider", tenantId: args.tenantId };
  }
  if (provider.status === "invalid" || provider.status === "disabled") {
    // Tenant has a default row but it's not usable. Treat as no-provider
    // to surface the configuration problem rather than silently breaking.
    return { kind: "strict_no_provider", tenantId: args.tenantId };
  }
  return { kind: "tenant_vault", provider };
}

// ─── Pending booking + checkout creation ──────────────────────────────

export type CreateCheckoutResult =
  | {
      ok: true;
      booking: Booking;
      provider: RedactedProviderRow;
      checkoutUrl: string;
      sessionId: string;
    }
  | {
      ok: false;
      reason:
        | "slot_held"
        | "slot_taken"
        | "internal"
        | "adapter_error"
        | "provider_disabled";
      message?: string;
    };

/**
 * Insert pending_payment + invoke the adapter to create the hosted
 * checkout. On adapter failure we mark the booking as payment_failed so
 * the slot is released — we never leave an orphaned pending_payment row
 * with no session id (the cron would catch it eventually, but eager
 * cleanup is friendlier).
 *
 * Tenant isolation is layered: caller passed providerId from the route
 * resolution; we re-load creds via getProviderWithCredentials(tenantId,
 * providerId) which ANDs both in the WHERE — so a spoofed providerId
 * from another tenant would 404 here, not silently authenticate.
 */
export async function createTenantVaultCheckout(args: {
  tenantId: string;
  providerId: string;
  servicePrice: number; // cents
  serviceCurrency: string; // ISO 4217, lowercase
  serviceDescription: string;
  customerEmail: string;
  /** Absolute base URL (e.g. https://app.zentromeet.com). We build the
   *  success/cancel URLs INSIDE this helper after the booking row is
   *  created so the actual bookingId — not a placeholder — is baked
   *  into the provider's checkout session. */
  appBaseUrl: string;
  pendingArgs: CreatePendingArgs;
  ipAddress: string | null;
}): Promise<CreateCheckoutResult> {
  // Step 1 — INSERT pending_payment WITH payment_provider_id stamped
  // so the webhook can verify provider ownership later.
  const pending = await createPendingPaymentBooking({
    ...args.pendingArgs,
    paymentProviderId: args.providerId,
  });
  if (!pending.ok) {
    return { ok: false, reason: pending.reason };
  }

  // Step 2 — load creds (decrypts envelope; in-frame plaintext only).
  const loaded = await getProviderWithCredentials(args.tenantId, args.providerId);
  if (!loaded) {
    // Race: provider deleted between route resolution and now. Roll
    // back the pending row by marking it payment_failed so the slot
    // releases immediately.
    await markBookingPaymentFailed({
      bookingId: pending.booking.id,
      tenantId: args.tenantId,
      reason: "provider_disappeared",
    });
    return { ok: false, reason: "provider_disabled" };
  }
  if (!loaded.row.enabled || loaded.row.status === "invalid" || loaded.row.status === "disabled") {
    await markBookingPaymentFailed({
      bookingId: pending.booking.id,
      tenantId: args.tenantId,
      reason: "provider_not_usable",
    });
    return { ok: false, reason: "provider_disabled" };
  }

  // Step 3 — dispatch to adapter. The adapter constructs its own
  // SDK/HTTP client per call with the tenant's secret. We pass
  // booking_id metadata so the webhook can resolve back to this row.
  // URLs are built HERE so the actual booking id (not a placeholder)
  // is baked into the provider's checkout session.
  const base = args.appBaseUrl.replace(/\/+$/, "");
  const successUrl = `${base}/booking/confirmed?booking=${pending.booking.id}`;
  const cancelUrl = `${base}/booking/cancelled?booking=${pending.booking.id}`;
  const adapter = getAdapter(loaded.row.provider as PaymentProviderId);
  let result: CheckoutResult;
  try {
    result = await adapter.createCheckout(loaded.creds, {
      bookingId: pending.booking.id,
      tenantId: args.tenantId,
      currency: args.serviceCurrency,
      amountCents: args.servicePrice,
      description: args.serviceDescription,
      customerEmail: args.customerEmail,
      successUrl,
      cancelUrl,
      metadata: {
        booking_id: pending.booking.id,
        tenant_id: args.tenantId,
        provider_id: args.providerId,
        kind: "booking_payment_tenant_vault",
      },
    });
  } catch (err) {
    // Adapter threw. Release the slot and surface to the customer.
    await markBookingPaymentFailed({
      bookingId: pending.booking.id,
      tenantId: args.tenantId,
      reason: "adapter_create_checkout_failed",
    });
    return {
      ok: false,
      reason: "adapter_error",
      message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    };
  }

  // Step 4 — persist provider session id back onto the booking. The
  // webhook receiver uses this for an extra defense-in-depth check
  // (event session_id must match what we stored).
  await db
    .update(bookings)
    .set({
      stripeSessionId: result.sessionId, // overloaded column; both Stripe + PayPal store here
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(bookings.id, pending.booking.id),
        eq(bookings.tenantId, args.tenantId),
      ),
    );

  // Step 5 — observability. Audit at INFO level; no PII beyond what's
  // already on the audit_logs table (customer email/name lives on the
  // booking row, audit just references the entity).
  audit({
    tenantId: args.tenantId,
    action: "booking.payment.checkout_created",
    entityType: "booking",
    entityId: pending.booking.id,
    metadata: {
      providerId: args.providerId,
      provider: loaded.row.provider,
      mode: loaded.row.mode,
      sessionId: result.sessionId,
      amountCents: args.servicePrice,
      currency: args.serviceCurrency,
    },
    ipAddress: args.ipAddress,
  });

  return {
    ok: true,
    booking: { ...pending.booking, stripeSessionId: result.sessionId },
    provider: {
      ...loaded.row,
      // Best-effort redacted view; the caller doesn't need the full row.
    } as unknown as RedactedProviderRow,
    checkoutUrl: result.checkoutUrl,
    sessionId: result.sessionId,
  };
}

// ─── Confirm-or-refund (the slot-race invariant lives here) ────────────
//
// CRITICAL ORDERING — per requirement 1 from the user:
//   If payment succeeded but the booking can no longer finalize:
//     1. REFUND FIRST  (release tenant's held funds)
//     2. THEN mark the booking terminal (release the hold)
//     3. THEN audit as orphan/manual-review
//     4. NEVER force-finalize
//
// We NEVER call runPostConfirmationHooks (calendar/email/etc.) unless
// confirmPendingPaymentBooking returned ok. The post-confirmation flow
// is the caller's responsibility AFTER we return ok:true.

export type ConfirmOutcome =
  | {
      ok: true;
      bookingId: string;
      tenantId: string;
      // Caller should immediately invoke runPostConfirmationHooks.
    }
  | {
      ok: false;
      reason:
        | "not_found"           // booking row gone — orphan, refund issued
        | "wrong_state"         // booking already cancelled/terminal
        | "slot_taken"          // EXCLUDE fired post-payment
        | "provider_mismatch"   // cross-provider spoof attempt
        | "tenant_mismatch"     // cross-tenant spoof attempt
        | "internal";           // unexpected
      refundResult?: RefundResult; // present when we attempted refund
    };

export async function confirmTenantVaultBooking(args: {
  bookingId: string;
  tenantId: string;
  providerId: string;
  externalSessionId: string;
  externalChargeId: string | null; // PI or capture id; null if unknown
  amountChargedCents: number;
  /** Adapter-supplied event id for audit correlation. */
  webhookEventId: string;
}): Promise<ConfirmOutcome> {
  // Step 0 — load creds NOW (before any DB transition) so we have them
  // ready if we need to refund. Tenant-isolated by helper contract.
  let creds: ProviderCredentials | null = null;
  let providerRow: TenantPaymentProvider | null = null;
  try {
    const loaded = await getProviderWithCredentials(args.tenantId, args.providerId);
    if (loaded) {
      creds = loaded.creds;
      providerRow = loaded.row;
    }
  } catch {
    creds = null;
  }

  // Step 1 — read booking + verify cross-IDs match BEFORE any state move.
  const existing = await db.query.bookings.findFirst({
    where: and(
      eq(bookings.id, args.bookingId),
      eq(bookings.tenantId, args.tenantId),
    ),
  });
  if (!existing) {
    // Orphan: webhook fired but our booking row never existed (e.g.
    // booking POST crashed before commit, then Stripe replayed). Money
    // is held by the provider — REFUND, then audit. We can refund only
    // if we know the charge id.
    let refundResult: RefundResult | undefined;
    if (creds && args.externalChargeId) {
      refundResult = await safeAdapterRefund(creds, {
        externalChargeId: args.externalChargeId,
        bookingId: args.bookingId,
        amountCents: null, // full
        reason: "orphan_no_booking_row",
      });
    }
    audit({
      tenantId: args.tenantId,
      action: "booking.payment.orphan_event",
      entityType: "booking",
      entityId: args.bookingId,
      metadata: {
        providerId: args.providerId,
        webhookEventId: args.webhookEventId,
        externalSessionId: args.externalSessionId,
        externalChargeId: args.externalChargeId,
        amountCents: args.amountChargedCents,
        refundAttempted: !!refundResult,
        refundOk: refundResult?.ok ?? false,
        reason: "booking_not_found",
      },
    });
    return { ok: false, reason: "not_found", refundResult };
  }

  // Spoofing defense — the booking row was found in OUR tenant, but
  // does it actually belong to the provider whose URL was hit?
  if (existing.paymentProviderId && existing.paymentProviderId !== args.providerId) {
    audit({
      tenantId: args.tenantId,
      action: "booking.payment.cross_provider_spoof_blocked",
      entityType: "booking",
      entityId: args.bookingId,
      metadata: {
        attemptedProviderId: args.providerId,
        actualProviderId: existing.paymentProviderId,
        webhookEventId: args.webhookEventId,
      },
    });
    // Refund the captured funds — the booking belongs to a different
    // provider, this event has no business modifying it.
    let refundResult: RefundResult | undefined;
    if (creds && args.externalChargeId) {
      refundResult = await safeAdapterRefund(creds, {
        externalChargeId: args.externalChargeId,
        bookingId: args.bookingId,
        amountCents: null,
        reason: "cross_provider_spoof_attempt",
      });
    }
    return { ok: false, reason: "provider_mismatch", refundResult };
  }

  // Also verify the provider row's tenant matches the booking's tenant.
  if (providerRow && providerRow.tenantId !== existing.tenantId) {
    // Should be impossible given getProviderWithCredentials filters on
    // tenantId, but defense in depth.
    audit({
      tenantId: args.tenantId,
      action: "booking.payment.cross_tenant_spoof_blocked",
      entityType: "booking",
      entityId: args.bookingId,
      metadata: {
        providerTenantId: providerRow.tenantId,
        bookingTenantId: existing.tenantId,
        webhookEventId: args.webhookEventId,
      },
    });
    return { ok: false, reason: "tenant_mismatch" };
  }

  // Step 2 — already-confirmed? Idempotent retry path.
  if (existing.status === "confirmed") {
    // No transition needed. Caller should NOT re-fire post-confirmation
    // hooks on a replay. Return ok:false with wrong_state so the caller
    // doesn't accidentally double-email the customer.
    audit({
      tenantId: args.tenantId,
      action: "booking.payment.webhook_replay_already_confirmed",
      entityType: "booking",
      entityId: args.bookingId,
      metadata: { webhookEventId: args.webhookEventId },
    });
    return { ok: false, reason: "wrong_state" };
  }

  // Step 3 — booking is in a terminal failure state (cancelled by cron,
  // payment_failed, refunded). The hold has already been released. Money
  // is sitting with the provider — REFUND FIRST, then audit.
  if (
    existing.status === "cancelled" ||
    existing.status === "payment_failed" ||
    existing.status === "refunded" ||
    existing.status === "completed" ||
    existing.status === "no_show"
  ) {
    let refundResult: RefundResult | undefined;
    if (creds && args.externalChargeId) {
      refundResult = await safeAdapterRefund(creds, {
        externalChargeId: args.externalChargeId,
        bookingId: args.bookingId,
        amountCents: null,
        reason: `late_arrival_booking_in_${existing.status}`,
      });
    }
    audit({
      tenantId: args.tenantId,
      action: "booking.payment.auto_refunded_late_arrival",
      entityType: "booking",
      entityId: args.bookingId,
      metadata: {
        providerId: args.providerId,
        webhookEventId: args.webhookEventId,
        bookingPreviousStatus: existing.status,
        refundAttempted: !!refundResult,
        refundOk: refundResult?.ok ?? false,
        refundReason: refundResult && !refundResult.ok ? refundResult.reason : undefined,
      },
    });
    return { ok: false, reason: "wrong_state", refundResult };
  }

  // Step 4 — booking is pending_payment. Attempt the transition.
  // confirmPendingPaymentBooking handles EXCLUDE race + auto-marks
  // payment_failed when slot_taken. We layer the REFUND on top of
  // that helper's existing behavior.
  const confirmResult = await confirmPendingPaymentBooking({
    bookingId: args.bookingId,
    tenantId: args.tenantId,
    stripeSessionId: args.externalSessionId,
    stripePaymentIntentId: args.externalChargeId, // overloaded column for both providers
    amountChargedCents: args.amountChargedCents,
  });

  if (confirmResult.ok) {
    // Successful finalize. Caller will fire post-confirmation hooks.
    audit({
      tenantId: args.tenantId,
      action: "booking.payment.confirmed_via_tenant_vault",
      entityType: "booking",
      entityId: args.bookingId,
      metadata: {
        providerId: args.providerId,
        webhookEventId: args.webhookEventId,
        amountChargedCents: args.amountChargedCents,
        externalSessionId: args.externalSessionId,
        externalChargeId: args.externalChargeId,
      },
    });
    return { ok: true, bookingId: args.bookingId, tenantId: args.tenantId };
  }

  // Confirm helper failed. If it was slot_taken, the helper already
  // marked the booking payment_failed. REFUND the captured charge
  // (slot-race invariant: refund before any further action).
  if (confirmResult.reason === "slot_taken") {
    let refundResult: RefundResult | undefined;
    if (creds && args.externalChargeId) {
      refundResult = await safeAdapterRefund(creds, {
        externalChargeId: args.externalChargeId,
        bookingId: args.bookingId,
        amountCents: null,
        reason: "slot_taken_during_payment",
      });
    }
    audit({
      tenantId: args.tenantId,
      action: "booking.payment.auto_refunded_slot_race",
      entityType: "booking",
      entityId: args.bookingId,
      metadata: {
        providerId: args.providerId,
        webhookEventId: args.webhookEventId,
        refundAttempted: !!refundResult,
        refundOk: refundResult?.ok ?? false,
      },
    });
    return { ok: false, reason: "slot_taken", refundResult };
  }

  // Other failures (not_found despite step 1 existing — race; internal).
  return { ok: false, reason: "internal" };
}

// ─── Webhook payment-failure path ──────────────────────────────────────

export async function failTenantVaultBooking(args: {
  bookingId: string;
  tenantId: string;
  providerId: string;
  webhookEventId: string;
  reason: string;
}): Promise<void> {
  const failed = await markBookingPaymentFailed({
    bookingId: args.bookingId,
    tenantId: args.tenantId,
    reason: args.reason.slice(0, 200),
  });
  audit({
    tenantId: args.tenantId,
    action: "booking.payment.failed_via_tenant_vault",
    entityType: "booking",
    entityId: args.bookingId,
    metadata: {
      providerId: args.providerId,
      webhookEventId: args.webhookEventId,
      reason: args.reason.slice(0, 200),
      result: failed.ok ? "marked" : failed.reason,
    },
  });
}

// ─── Internal: never-throws refund wrapper ─────────────────────────────

async function safeAdapterRefund(
  creds: ProviderCredentials,
  argsToRefund: {
    externalChargeId: string;
    bookingId: string;
    amountCents: number | null;
    reason: string;
  },
): Promise<RefundResult> {
  const adapter = getAdapter(creds.kind as PaymentProviderId);
  try {
    return await adapter.refund(creds, argsToRefund);
  } catch (err) {
    return {
      ok: false,
      errorClass: "unknown",
      reason: err instanceof Error ? err.message.slice(0, 200) : "refund_threw",
    };
  }
}

// ─── Webhook receiver helper for marking webhook delivery healthy ──────
// Convenience re-export so the receiver doesn't import from both modules.
export { recordWebhookSuccess };
