/**
 * Wave H — provider registry.
 *
 * Single chokepoint that maps a `PaymentProviderId` to the concrete
 * adapter implementing the `PaymentProvider` contract. Callers ONLY
 * import `getAdapter` from here — never reach into `./stripe/adapter`
 * directly — so adding a provider in Phase 2+ is one line here.
 *
 * Why not a Map literal? Lazy SDK init: each adapter dynamic-imports
 * its provider SDK on first call (the Stripe adapter uses `import
 * ("stripe")` inside its methods). The registry itself stays
 * dependency-free so unit tests can import it without dragging in
 * the entire Stripe SDK.
 */

import type { PaymentProvider } from "./provider";
import type { PaymentProviderId } from "./types";

import { stripeAdapter } from "./stripe/adapter";

const REGISTRY: Record<PaymentProviderId, PaymentProvider> = {
  stripe: stripeAdapter,
  // paypal: paypalAdapter,  // Phase 2 — gated behind verification report
  // square: ...              // future
  // authorize_net: ...       // future
  // Temporary stub keeps the type complete for Phase 1.
  paypal: {
    id: "paypal",
    async validateCredentials() {
      return {
        ok: false,
        errorClass: "config",
        message: "PayPal adapter not implemented in Phase 1",
      };
    },
    async createCheckout() {
      throw new Error("PayPal adapter not implemented in Phase 1");
    },
    async verifyWebhook() {
      return null;
    },
  },
};

export function getAdapter(id: PaymentProviderId): PaymentProvider {
  const adapter = REGISTRY[id];
  if (!adapter) {
    throw new Error(`No payment adapter registered for provider '${id}'`);
  }
  return adapter;
}

/** Closed list for UI enumeration ("which providers can a tenant
 *  configure right now?"). Adapters not yet implemented can return
 *  `validateCredentials: { ok: false, errorClass: 'config' }` and the
 *  UI can render them as "Coming soon" rather than hide them. */
export const SUPPORTED_PROVIDERS: PaymentProviderId[] = ["stripe", "paypal"];
