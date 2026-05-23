/**
 * Wave H — abstract PaymentProvider contract.
 *
 * Every concrete adapter (Stripe today, PayPal Phase 2, Square/AuthNet
 * future) implements THIS interface. The booking flow + webhook receiver
 * + dashboard talk to this contract only — they never reach into a
 * specific SDK.
 *
 * Stateless on purpose: adapters take credentials per call rather than
 * holding them as instance state. That mirrors `lib/calendar/google.ts`
 * et al. (Waves A–D) and avoids accidental cross-tenant key bleed in
 * any cached singleton.
 */

import type {
  CheckoutArgs,
  CheckoutResult,
  PaymentProviderId,
  ProviderCredentials,
  ValidationResult,
  VerifyWebhookResult,
} from "./types";

export interface PaymentProvider {
  /** Closed-set identifier matching `tenant_payment_providers.provider`. */
  readonly id: PaymentProviderId;

  /**
   * Round-trips the credentials against the provider to confirm they
   * authenticate AND extract capability metadata (account country,
   * default currency, charges_enabled, etc.). Called:
   *   • At "Test connection" before final save
   *   • After save, to flip `status` to 'verified'
   *   • By the periodic re-validation worker (Phase 5)
   *
   * MUST NOT throw on auth failure — return `{ ok: false, ... }`.
   * Throwing is reserved for true bugs (e.g. malformed input the caller
   * was supposed to sanitize).
   */
  validateCredentials(creds: ProviderCredentials): Promise<ValidationResult>;

  /**
   * Creates a hosted checkout session on the tenant's account. Returns
   * the redirect URL the booker is sent to. Idempotent on `bookingId`:
   * the adapter MUST pass that as the provider's idempotency key so
   * retries return the same session, never a duplicate charge.
   *
   * The funds settle directly to the tenant — there is no application
   * fee, no destination charge, no platform routing. ZentroMeet does
   * not appear in the money path.
   */
  createCheckout(
    creds: ProviderCredentials,
    args: CheckoutArgs,
  ): Promise<CheckoutResult>;

  /**
   * Verifies a webhook payload's signature using the stored webhook
   * secret and normalizes the event into our shared `WebhookEvent`
   * shape. Returns null on signature failure / replay-outside-tolerance
   * — the receiver MUST treat null as a hard reject.
   *
   * Signature verification uses the PROVIDER'S library (e.g.
   * `stripe.webhooks.constructEvent`) — never hand-rolled HMAC.
   */
  verifyWebhook(
    creds: ProviderCredentials,
    rawBody: string,
    signatureHeader: string,
  ): Promise<VerifyWebhookResult>;
}
