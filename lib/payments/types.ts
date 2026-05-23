/**
 * Wave H — Tenant Payment Provider Vault — shared types.
 *
 * Closed, narrow types that the abstract `PaymentProvider` contract
 * (in `lib/payments/provider.ts`) consumes. Provider adapters MAP
 * their SDK shapes into these — callers never see the SDK directly.
 *
 * Architectural reminder: ZentroMeet does NOT operate as a marketplace.
 * Each tenant brings their own Stripe / PayPal credentials; the
 * adapter instantiates the provider SDK with THOSE creds per call.
 * Money flows tenant ↔ customer. No platform fees, no destination
 * charges, no Connect.
 */

/** Closed set of providers Phase 1+2 will ship. New entries here must
 *  be matched by a registry entry in `lib/payments/registry.ts`. */
export type PaymentProviderId = "stripe" | "paypal";

/** Two modes a tenant can configure in parallel. The booking flow
 *  resolves which one to use via `is_default` on the providers table. */
export type PaymentMode = "live" | "test";

/** Lifecycle of a stored credential row. Mirrors the `status` column
 *  on `tenant_payment_providers`. */
export type ProviderStatus = "pending" | "verified" | "invalid" | "disabled";

/** Outcome of `validateCredentials()` — every adapter MUST classify
 *  failures into one of these so the UI can render the right hint. */
export type ValidationErrorClass =
  | "auth"          // credentials rejected by provider (bad key)
  | "permission"    // creds work but account lacks a needed scope
  | "config"        // missing env or malformed input — pre-call failure
  | "rate_limit"    // 429 from provider
  | "transient"     // 5xx / network / DNS — caller may retry
  | "unknown";      // anything else — log + surface as-is

/** Capability snapshot stored on each row's `capabilities` jsonb.
 *  Adapters return whichever subset they can answer. The dashboard
 *  uses these to render the "ready to charge?" health card. */
export interface ProviderCapabilities {
  /** Provider's own account identifier (acct_… for Stripe). Useful
   *  for support tickets and webhook double-checks. */
  accountId?: string;
  /** ISO 3166-1 alpha-2 country of the merchant account. */
  country?: string;
  /** Lowercase ISO 4217 default currency (e.g. "usd"). */
  defaultCurrency?: string;
  /** Currencies the account can charge in. Lowercase ISO 4217. */
  currencies?: string[];
  /** Stripe `charges_enabled` semantics — can the account create new
   *  charges right now? PayPal adapter can map merchant verification
   *  status into this same boolean. */
  chargesEnabled?: boolean;
  /** Stripe `payouts_enabled` semantics — can funds reach the tenant's
   *  bank? We surface this in the dashboard but never block bookings
   *  on it: payouts are between tenant and provider, not our concern. */
  payoutsEnabled?: boolean;
  /** Free-form extras adapters can stash (PayPal business email,
   *  merchant id, etc.). Kept loose on purpose. */
  [key: string]: unknown;
}

export interface ValidateOk {
  ok: true;
  capabilities: ProviderCapabilities;
}

export interface ValidateError {
  ok: false;
  errorClass: ValidationErrorClass;
  message: string;
}

export type ValidationResult = ValidateOk | ValidateError;

/** Plaintext credentials handed to an adapter at call time. The
 *  vault (`lib/payments/connections.ts`) is the ONLY place that
 *  decrypts envelope → plaintext, and these structs never leave a
 *  server-side function frame. */
export interface StripeCredentials {
  kind: "stripe";
  secretKey: string;          // sk_live_… / sk_test_…
  publishableKey: string | null;
  webhookSecret: string | null; // whsec_…
}

export interface PayPalCredentials {
  kind: "paypal";
  clientId: string;
  clientSecret: string;
  webhookId: string | null;
  /** PayPal has separate sandbox vs live host URLs; we derive from mode. */
  mode: PaymentMode;
}

export type ProviderCredentials = StripeCredentials | PayPalCredentials;

/** Input to `createCheckout()`. The orchestrator (Phase 3) assembles
 *  this from the booking + service + tenant settings. */
export interface CheckoutArgs {
  /** Used as the provider's idempotency key. Same booking id retried
   *  must return the same checkout session, never create a duplicate
   *  charge. Bookings code already emits stable ids. */
  bookingId: string;
  tenantId: string;
  /** Lowercase ISO 4217. Validated against `capabilities.currencies`
   *  upstream so we never hand the provider an unsupported value. */
  currency: string;
  amountCents: number;
  /** What the customer sees on the checkout page. */
  description: string;
  customerEmail: string;
  /** Where the provider redirects after success / cancel. The booking
   *  POST handler hands fully-qualified absolute URLs. */
  successUrl: string;
  cancelUrl: string;
  /** Free-form metadata echoed back on the webhook event. We always
   *  set { bookingId, tenantId, providerId } so the webhook receiver
   *  can resolve the booking without trusting URL params. */
  metadata: Record<string, string>;
}

export interface CheckoutResult {
  /** Provider-side session id (cs_… for Stripe, order id for PayPal). */
  sessionId: string;
  /** Where the browser is sent to begin payment. */
  checkoutUrl: string;
}

/** Normalized webhook event the receiver dispatches on. Adapters
 *  translate their SDK event shape into THIS — the receiver never
 *  reaches into provider-specific fields. */
export type WebhookEventKind =
  | "checkout.completed"     // success — transition booking to confirmed
  | "checkout.failed"        // explicit failure — transition to payment_failed
  | "refund.created"         // partial or full refund — surface in UI
  | "account.updated"        // capabilities changed — refresh status
  | "unhandled";             // event_type isn't one we act on

export interface WebhookEvent {
  /** Provider's own event id. Used for dedup against
   *  `tenant_payment_webhook_events.external_event_id`. */
  id: string;
  kind: WebhookEventKind;
  /** Raw event_type string from the provider, for audit/log. */
  rawType: string;
  /** Resolved booking id if the event carries enough metadata; null
   *  otherwise. The receiver still logs the event even if null. */
  bookingId: string | null;
  /** Amount touched by this event (charged, refunded). Adapters
   *  normalize to cents. Null if the event isn't financial. */
  amountCents: number | null;
  /** Lowercase ISO 4217. Null when non-financial. */
  currency: string | null;
  /** Provider-specific payload, opaque to the receiver. Stored for
   *  audit; never trusted for control flow. */
  raw: unknown;
}

/** Result of `verifyWebhook()`. Null = signature failed / replayed
 *  outside tolerance. The receiver MUST reject without further work. */
export type VerifyWebhookResult = WebhookEvent | null;
