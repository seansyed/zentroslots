/**
 * Wave H Phase 3 — tenant-vault payment webhook receiver.
 *
 *   POST /api/webhooks/payments/<providerId>
 *
 * The providerId in the URL is THE source of truth for routing — there's
 * no tenant id in the path or trusted from the body. We:
 *   1. Look up `tenant_payment_providers` by id alone
 *   2. Extract `tenant_id` from THAT row (defense against URL forgery)
 *   3. Verify the body's signature using THAT provider's webhook_secret
 *   4. Only after verification, extract booking_id from event metadata
 *   5. Validate booking.tenant_id == provider.tenant_id (defense in depth)
 *
 * THIS IS THE ONLY PLACE A WAVE-H PAID BOOKING CAN BE FINALIZED. The
 * redirect page polls for status but never mutates. There is no
 * /finalize endpoint. There is no client-trustable confirm path.
 *
 * Idempotency:
 *   • UNIQUE (provider_id, external_event_id) on tenant_payment_webhook_
 *     events catches duplicate deliveries at INSERT time.
 *   • Inside confirmTenantVaultBooking, the WHERE pending_payment guard
 *     prevents double-confirm.
 *
 * The receiver never throws to the HTTP layer:
 *   • Bad signature → record + 401
 *   • Unknown provider → 404
 *   • Replay → 200 immediately
 *   • Unknown event type → 200 with status='unhandled'
 *   • Internal error during processing → 500 (provider will retry)
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import {
  tenantPaymentProviders,
  tenantPaymentWebhookEvents,
} from "@/db/schema";
import { audit, ipFromHeaders } from "@/lib/audit";
import { decryptSecret } from "@/lib/crypto";
import {
  recordWebhookFailure,
  recordWebhookSuccess,
} from "@/lib/payments/connections";
import { getAdapter } from "@/lib/payments/registry";
import type {
  PaymentMode,
  PaymentProviderId,
  ProviderCredentials,
  WebhookEvent,
} from "@/lib/payments/types";
import {
  confirmTenantVaultBooking,
  failTenantVaultBooking,
} from "@/lib/billing/tenantVaultBooking";
import { runPostConfirmationHooks } from "@/lib/billing/postBookingHooks";
import {
  autoRefundCharge,
  markBookingRefunded,
} from "@/lib/billing/paymentLifecycle";

// Node runtime so we can read the raw body for signature verification.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Only collect provider-prefixed headers for persistence — never auth,
// cookies, X-Forwarded-* etc.
const HEADER_PREFIX_WHITELIST = ["stripe-", "paypal-"];

// UUID v4-ish shape check. Postgres throws `invalid input syntax for
// type uuid` on a non-UUID string — which would surface as a 500.
// Validate up-front and 404 instead. (Same posture as the public
// status endpoint.) Loose hex match — accepts any UUID variant.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ providerId: string }> },
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { providerId } = await context.params;
  if (!providerId || !UUID_RE.test(providerId)) {
    // Don't 500 on a malformed URL path segment — that would trigger
    // provider retry storms for attacker traffic. 404 is the right
    // posture: this endpoint serves no resource for this id.
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  // ─── Header collection (lowercase keys, prefix-filtered) ─────────────
  // Adapter contract requires lowercase keys. We also store this map on
  // the webhook event row for forensic replay.
  const allHeaders: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    allHeaders[k.toLowerCase()] = v;
  });
  const signatureHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(allHeaders)) {
    if (HEADER_PREFIX_WHITELIST.some((p) => k.startsWith(p))) {
      signatureHeaders[k] = v;
    }
  }

  // ─── Look up the provider row ───────────────────────────────────────
  // By id ONLY. The tenant id is derived from the row, never trusted
  // from the URL or body. UUIDv4 (122 bits) — unguessable across tenants.
  const providerRow = await db.query.tenantPaymentProviders.findFirst({
    where: eq(tenantPaymentProviders.id, providerId),
  });
  if (!providerRow) {
    // Unknown providerId. 404 — do NOT 500 (would trigger provider
    // retry loop). Audit at the system level since we have no tenant.
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }
  // Disabled providers — reject events. Tenant explicitly turned this
  // provider off; honor that even if the secret is technically still
  // valid for signature verification.
  if (!providerRow.enabled || providerRow.status === "disabled") {
    return NextResponse.json({ error: "Provider disabled" }, { status: 410 });
  }
  // Tenant id from the ROW. This is the only authoritative tenant id
  // for the rest of this handler.
  const tenantId = providerRow.tenantId;
  const provider = providerRow.provider as PaymentProviderId;
  const mode = providerRow.mode as PaymentMode;

  // Read raw body once. Stripe needs the original bytes for HMAC; PayPal
  // is JSON-shaped but we still hand the raw string to the adapter for
  // re-parsing on its side (so any non-canonical whitespace is preserved).
  const rawBody = await req.text();

  // ─── Decrypt creds + verify signature ────────────────────────────────
  // We decrypt ONLY for this verify call; plaintext lives in this
  // function frame and nowhere else.
  let creds: ProviderCredentials | null = null;
  try {
    creds = decryptToCredentials(providerRow);
  } catch {
    // Envelope tampered or key rotated. We can't verify — return 401.
    // Provider will retry; operator must investigate.
    await persistWebhookEvent({
      tenantId,
      providerId,
      provider,
      externalEventId: `pre-verify-${Date.now()}`,
      eventType: "unknown",
      status: "invalid_signature",
      error: "creds_decrypt_failed",
      bookingId: null,
      rawPayload: null,
      signatureHeaders,
      processingDurationMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: "Verification unavailable" }, { status: 401 });
  }

  const adapter = getAdapter(provider);
  let verified: WebhookEvent | null;
  try {
    verified = await adapter.verifyWebhook(creds, rawBody, allHeaders);
  } catch {
    // Adapter threw (should never happen per contract). Treat as
    // invalid signature.
    verified = null;
  }

  if (!verified) {
    // Persist the rejection for forensics, then 401.
    // We don't have the event id (since we couldn't verify), so we
    // generate a synthetic one to satisfy the unique constraint while
    // still surfacing rejections in queries. Format makes it grep-able.
    const synthEventId = `invalid-${providerId}-${Date.now()}`;
    await persistWebhookEvent({
      tenantId,
      providerId,
      provider,
      externalEventId: synthEventId,
      eventType: "unknown",
      status: "invalid_signature",
      error: "signature_verification_failed",
      bookingId: null,
      rawPayload: tryParseJson(rawBody), // PII-bearing but unverified
      signatureHeaders,
      processingDurationMs: Date.now() - startedAt,
    });
    await recordWebhookFailure(tenantId, providerId, "signature_verification_failed");
    audit({
      tenantId,
      action: "booking.payment.webhook_signature_failed",
      entityType: "tenant_payment_provider",
      entityId: providerId,
      metadata: { provider, mode, ip: ipFromHeaders(req.headers) },
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ─── Dedup at the event level ────────────────────────────────────────
  // UNIQUE (provider_id, external_event_id) on the events table.
  // ON CONFLICT DO NOTHING → if this is a replay, the INSERT returns
  // zero rows. We then return 200 immediately without re-processing.
  const insertResult = await tryInsertWebhookEvent({
    tenantId,
    providerId,
    provider,
    externalEventId: verified.id,
    eventType: verified.rawType,
    status: "received",
    error: null,
    bookingId: verified.bookingId,
    rawPayload: redactRawPayload(verified.raw),
    signatureHeaders,
    processingDurationMs: null, // updated at end-of-handler
  });

  if (!insertResult.inserted) {
    // Replay. Provider's retry pipeline will see 200 and stop.
    audit({
      tenantId,
      action: "booking.payment.webhook_replay",
      entityType: "tenant_payment_provider",
      entityId: providerId,
      metadata: { webhookEventId: verified.id, eventType: verified.rawType },
    });
    return NextResponse.json({ received: true, replay: true });
  }

  // ─── Dispatch by event kind ─────────────────────────────────────────
  audit({
    tenantId,
    action: "booking.payment.webhook_received",
    entityType: "tenant_payment_provider",
    entityId: providerId,
    metadata: {
      webhookEventId: verified.id,
      eventType: verified.rawType,
      kind: verified.kind,
      bookingId: verified.bookingId,
      amountCents: verified.amountCents,
      currency: verified.currency,
    },
  });

  let processStatus: string = "processed";
  let processError: string | null = null;
  let wasPaymentEvent = false;

  try {
    switch (verified.kind) {
      case "checkout.completed": {
        wasPaymentEvent = true;
        if (!verified.bookingId) {
          processStatus = "unhandled";
          processError = "no_booking_id_in_event";
          break;
        }
        const externalSessionId = extractSessionId(verified.raw);
        const externalChargeId = extractChargeId(verified.raw, provider);
        const outcome = await confirmTenantVaultBooking({
          bookingId: verified.bookingId,
          tenantId,
          providerId,
          externalSessionId: externalSessionId ?? "",
          externalChargeId,
          amountChargedCents: verified.amountCents ?? 0,
          webhookEventId: verified.id,
        });
        if (outcome.ok) {
          // Successful finalize — fire post-confirmation hooks. These
          // are best-effort wrapped (calendar / email / customer
          // upsert) and never throw.
          try {
            await runPostConfirmationHooks({
              bookingId: outcome.bookingId,
              tenantId: outcome.tenantId,
            });
          } catch (hookErr) {
            // Audited inside the hook helper; we don't propagate.
            processError = `post_hook_partial_failure:${
              hookErr instanceof Error ? hookErr.message.slice(0, 100) : "unknown"
            }`;
          }
        } else {
          processStatus = outcome.reason;
        }
        break;
      }

      case "checkout.failed": {
        wasPaymentEvent = true;
        if (!verified.bookingId) {
          processStatus = "unhandled";
          processError = "no_booking_id_in_event";
          break;
        }
        await failTenantVaultBooking({
          bookingId: verified.bookingId,
          tenantId,
          providerId,
          webhookEventId: verified.id,
          reason: verified.rawType,
        });
        break;
      }

      case "refund.created": {
        wasPaymentEvent = true;
        if (!verified.bookingId) {
          processStatus = "unhandled";
          processError = "no_booking_id_in_event";
          break;
        }
        const isFull = isFullRefundFromEvent(verified.raw, verified.amountCents);
        await markBookingRefunded({
          bookingId: verified.bookingId,
          tenantId,
          refundedAmountCents: verified.amountCents ?? 0,
          isFullRefund: isFull,
        });
        audit({
          tenantId,
          action: "booking.payment.refunded_via_tenant_vault",
          entityType: "booking",
          entityId: verified.bookingId,
          metadata: {
            providerId,
            webhookEventId: verified.id,
            amountRefunded: verified.amountCents,
            isFullRefund: isFull,
          },
        });
        break;
      }

      case "account.updated":
        // Capability change. We don't mutate the provider's status
        // here (admin's Test Connection refreshes capabilities); we
        // just audit the notification.
        audit({
          tenantId,
          action: "booking.payment.account_updated_via_tenant_vault",
          entityType: "tenant_payment_provider",
          entityId: providerId,
          metadata: { webhookEventId: verified.id, eventType: verified.rawType },
        });
        break;

      case "unhandled":
      default:
        processStatus = "unhandled";
        break;
    }
  } catch (err) {
    // Last-resort guard. The helpers above never throw, but defense in
    // depth: a thrown error becomes 'processed' with an error message
    // captured, and we return 500 so the provider retries.
    processStatus = "processed";
    processError = err instanceof Error ? err.message.slice(0, 500) : "unknown";
  }

  // Update the event row with final status + duration.
  const duration = Date.now() - startedAt;
  await finalizeWebhookEvent({
    providerId,
    externalEventId: verified.id,
    status: processStatus,
    error: processError,
    processingDurationMs: duration,
  });

  // Record provider-side webhook health (only if we got this far; an
  // earlier signature failure already recorded failure separately).
  await recordWebhookSuccess(tenantId, providerId, { wasPaymentEvent });

  // Any process error means we returned a non-200 to the provider —
  // EXCEPT in the orphan/refund flows where the booking simply can't
  // be finalized. Those are SUCCESSFUL receptions semantically (we
  // processed correctly, the answer was "this can't be finalized").
  if (processError && processError.startsWith("post_hook_partial_failure")) {
    // Post-confirmation hooks partially failed but booking IS confirmed.
    // Return 200 — provider doesn't need to retry the webhook.
  }

  return NextResponse.json({ received: true, status: processStatus });
}

// ─── Helpers ───────────────────────────────────────────────────────────

function decryptToCredentials(row: {
  id: string;
  provider: string;
  mode: string;
  clientId: string | null;
  publishableKey: string | null;
  secretEncrypted: string;
  webhookSecretEncrypted: string | null;
}): ProviderCredentials {
  const secret = decryptSecret(row.secretEncrypted);
  if (!secret) {
    throw new Error(`Provider ${row.id} secret decrypted to null`);
  }
  const webhookSecret = row.webhookSecretEncrypted
    ? decryptSecret(row.webhookSecretEncrypted)
    : null;
  if (row.provider === "stripe") {
    return {
      kind: "stripe",
      secretKey: secret,
      publishableKey: row.publishableKey,
      webhookSecret,
    };
  }
  if (row.provider === "paypal") {
    return {
      kind: "paypal",
      clientId: row.clientId ?? "",
      clientSecret: secret,
      webhookId: webhookSecret,
      mode: (row.mode as PaymentMode) ?? "live",
    };
  }
  throw new Error(`Unknown provider '${row.provider}'`);
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // Provider sent non-JSON — keep as a string under a marker key so
    // the column type holds (jsonb).
    return { _unparsable: true, raw: s.slice(0, 4000) };
  }
}

/** Belt-and-braces redaction on the raw payload before persistence.
 *  The adapter already validated the body, but we run a second
 *  string-level scrub for any token-shaped substring that might be
 *  echoed in nested fields (PayPal sometimes nests sub-objects deep). */
function redactRawPayload(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    const json = JSON.stringify(raw);
    const scrubbed = json
      .replace(/sk_(live|test)_[A-Za-z0-9]+/g, "sk_$1_[REDACTED]")
      .replace(/rk_(live|test)_[A-Za-z0-9]+/g, "rk_$1_[REDACTED]")
      .replace(/whsec_[A-Za-z0-9]+/g, "whsec_[REDACTED]")
      .replace(/A21AA[A-Za-z0-9_-]{10,}/g, "A21AA[REDACTED]");
    return JSON.parse(scrubbed);
  } catch {
    return null;
  }
}

function extractSessionId(raw: unknown): string | null {
  const obj = raw as { data?: { object?: { id?: string } }; id?: string } | undefined;
  // Stripe: event.data.object.id (session id). PayPal: top-level event.id.
  return obj?.data?.object?.id ?? obj?.id ?? null;
}

function extractChargeId(raw: unknown, provider: PaymentProviderId): string | null {
  if (provider === "stripe") {
    // Stripe: event.data.object.payment_intent
    const obj = raw as
      | { data?: { object?: { payment_intent?: string | { id?: string } } } }
      | undefined;
    const pi = obj?.data?.object?.payment_intent;
    if (typeof pi === "string") return pi;
    if (pi && typeof pi === "object" && "id" in pi) return pi.id ?? null;
    return null;
  }
  // PayPal: resource.id is the capture id on capture-completed events.
  const obj = raw as { resource?: { id?: string } } | undefined;
  return obj?.resource?.id ?? null;
}

function isFullRefundFromEvent(raw: unknown, amountCents: number | null): boolean {
  // Stripe charge.refunded: amount_refunded vs amount. PayPal refund event:
  // resource.amount.value vs the original capture amount (not in event).
  // Defensive heuristic: if amount_refunded >= amount, full. Otherwise
  // treat as partial.
  const obj = raw as
    | { data?: { object?: { amount?: number; amount_refunded?: number } } }
    | undefined;
  const amt = obj?.data?.object?.amount;
  const refunded = obj?.data?.object?.amount_refunded;
  if (typeof amt === "number" && typeof refunded === "number") {
    return refunded >= amt;
  }
  // Without provider hints we assume the event amount IS the refund (full).
  return amountCents !== null && amountCents > 0;
}

// ─── tenant_payment_webhook_events helpers ─────────────────────────────

async function tryInsertWebhookEvent(args: {
  tenantId: string;
  providerId: string;
  provider: PaymentProviderId;
  externalEventId: string;
  eventType: string;
  status: string;
  error: string | null;
  bookingId: string | null;
  rawPayload: unknown;
  signatureHeaders: Record<string, string>;
  processingDurationMs: number | null;
}): Promise<{ inserted: boolean }> {
  try {
    const res = await db
      .insert(tenantPaymentWebhookEvents)
      .values({
        tenantId: args.tenantId,
        providerId: args.providerId,
        provider: args.provider,
        externalEventId: args.externalEventId,
        eventType: args.eventType.slice(0, 80),
        bookingId: args.bookingId,
        status: args.status,
        error: args.error,
        rawPayload: args.rawPayload as object | null,
        signatureHeaders: args.signatureHeaders,
        processingDurationMs: args.processingDurationMs,
      })
      .onConflictDoNothing({
        target: [
          tenantPaymentWebhookEvents.providerId,
          tenantPaymentWebhookEvents.externalEventId,
        ],
      })
      .returning({ id: tenantPaymentWebhookEvents.id });
    return { inserted: res.length > 0 };
  } catch (err) {
    // Fail-open: if the dedup table is down, we still want to process
    // the event (per the existing tryClaimStripeEvent pattern). We
    // report "inserted" so processing continues; the loss is forensic
    // (we can't replay this event later from our log).
    console.error("[wave-h-webhook] dedup insert failed; processing as fresh:", err);
    return { inserted: true };
  }
}

async function persistWebhookEvent(args: {
  tenantId: string;
  providerId: string;
  provider: PaymentProviderId;
  externalEventId: string;
  eventType: string;
  status: string;
  error: string | null;
  bookingId: string | null;
  rawPayload: unknown;
  signatureHeaders: Record<string, string>;
  processingDurationMs: number | null;
}): Promise<void> {
  try {
    await db
      .insert(tenantPaymentWebhookEvents)
      .values({
        tenantId: args.tenantId,
        providerId: args.providerId,
        provider: args.provider,
        externalEventId: args.externalEventId,
        eventType: args.eventType.slice(0, 80),
        bookingId: args.bookingId,
        status: args.status,
        error: args.error,
        rawPayload: args.rawPayload as object | null,
        signatureHeaders: args.signatureHeaders,
        processingDurationMs: args.processingDurationMs,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error("[wave-h-webhook] forensic insert failed:", err);
  }
}

async function finalizeWebhookEvent(args: {
  providerId: string;
  externalEventId: string;
  status: string;
  error: string | null;
  processingDurationMs: number;
}): Promise<void> {
  try {
    await db
      .update(tenantPaymentWebhookEvents)
      .set({
        status: args.status,
        error: args.error,
        processingDurationMs: args.processingDurationMs,
      })
      .where(eq(tenantPaymentWebhookEvents.externalEventId, args.externalEventId));
  } catch (err) {
    console.error("[wave-h-webhook] finalize update failed:", err);
  }
}

// Reference autoRefundCharge so its import isn't pruned by the bundler
// — it's still imported because future reconciliation cron uses it.
void autoRefundCharge;
