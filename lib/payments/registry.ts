/**
 * Wave H — provider registry.
 *
 * Single chokepoint that maps a `PaymentProviderId` to the concrete
 * adapter implementing the `PaymentProvider` contract. Callers ONLY
 * import `getAdapter` from here — never reach into a specific adapter
 * file directly — so adding a provider in future phases is one line.
 *
 * Why not a Map literal? Lazy SDK init: each adapter dynamic-imports
 * (Stripe) or fetches against (PayPal) its provider on first call. The
 * registry itself stays dependency-free so unit tests can import it
 * without dragging in any provider SDK.
 */

import type { PaymentProvider } from "./provider";
import type { PaymentProviderId } from "./types";

import { paypalAdapter } from "./paypal/adapter";
import { stripeAdapter } from "./stripe/adapter";

const REGISTRY: Record<PaymentProviderId, PaymentProvider> = {
  stripe: stripeAdapter,
  paypal: paypalAdapter, // Phase 2 — REST-based, no SDK dependency
  // square: ...           // future
  // authorize_net: ...    // future
};

export function getAdapter(id: PaymentProviderId): PaymentProvider {
  const adapter = REGISTRY[id];
  if (!adapter) {
    throw new Error(`No payment adapter registered for provider '${id}'`);
  }
  return adapter;
}

/** Closed list for UI enumeration ("which providers can a tenant
 *  configure right now?"). Adapters not yet implemented should be
 *  removed from this list rather than left as no-op stubs — UI uses
 *  this directly to render the provider chooser. */
export const SUPPORTED_PROVIDERS: PaymentProviderId[] = ["stripe", "paypal"];
