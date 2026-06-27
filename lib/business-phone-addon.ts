// Business Phone add-on — PURE billing-driven entitlement resolver (Phase 1).
//
// NO database, NO Stripe SDK, NO network, NO React — just the logic the Stripe
// webhook uses to decide whether a tenant's Business Phone add-on entitlement
// is active, given the subscription's line items and status.
//
// THIS IS THE BILLING FOUNDATION ONLY. It grants entitlement to the existing
// product: inbound call forwarding + manually-provisioned click-to-call bridge.
// It does NOT enable a browser softphone — that is Phase 2 (coming soon), not
// implemented here.

/**
 * Subscription statuses that SUSPEND a paid add-on. Mirrors the existing billing
 * suspension policy (lib/billing/cronGuards.ts `SUSPENDED_STATUSES`):
 *   - `past_due` is intentionally NOT here — the customer is inside Stripe's
 *     retry/grace window, so the add-on stays active until Stripe flips the
 *     status to `unpaid` (or cancels), which ARE here.
 */
export const ADDON_SUSPENDED_STATUSES: ReadonlySet<string> = new Set([
  "canceled",
  "unpaid",
  "incomplete_expired",
]);

/** Where a tenant's add-on entitlement came from. A "manual" entitlement is a
 *  pilot/comp grant set by an operator (e.g. docs-demo) and must NEVER be
 *  overwritten by Stripe-driven webhook logic. */
export type AddonEntitlementSource = "manual" | "stripe";

/** Minimal shape of a Stripe subscription line item (only the price id needed). */
export type AddonSubscriptionItem = { priceId: string | null | undefined };

export type AddonEntitlement = {
  /** The add-on line item is present on the subscription. */
  subscribed: boolean;
  /** Entitlement should be ACTIVE — subscribed AND status not suspended. */
  active: boolean;
};

/**
 * Decide a tenant's Business Phone add-on entitlement from Stripe subscription
 * state. PURE + fully testable.
 *
 * - `subscribed` = any line item's price matches the add-on price.
 * - `active`     = `subscribed` AND `subscriptionStatus` ∉ ADDON_SUSPENDED_STATUSES.
 *
 * `isAddonPrice` is injected (the env-backed lookup lives in lib/stripe.ts) so
 * this module stays pure. `source` is accepted for call-site symmetry but does
 * NOT change the computed Stripe facts — the manual-pilot protection is enforced
 * separately by `shouldStripeWriteEntitlement(source)`, which the webhook checks
 * BEFORE writing.
 */
export function resolveAddonEntitlement(args: {
  items: AddonSubscriptionItem[];
  subscriptionStatus?: string | null;
  source?: AddonEntitlementSource | null;
  isAddonPrice: (priceId: string | null | undefined) => boolean;
}): AddonEntitlement {
  const subscribed = (args.items ?? []).some((it) => args.isAddonPrice(it?.priceId));
  const status = String(args.subscriptionStatus ?? "").toLowerCase().trim();
  const suspended = ADDON_SUSPENDED_STATUSES.has(status);
  return { subscribed, active: subscribed && !suspended };
}

/**
 * Manual-source guard. The Stripe webhook must call this before writing a
 * tenant's entitlement: a "manual" pilot/comp grant (docs-demo) is owned by an
 * operator and is never clobbered by billing logic. Returns true only when
 * Stripe is allowed to write (source is unset or already "stripe").
 */
export function shouldStripeWriteEntitlement(
  source: AddonEntitlementSource | string | null | undefined,
): boolean {
  return source !== "manual";
}

/** Read the entitlement source from a settings-row `metadata` jsonb value.
 *  Returns "manual" only when explicitly marked; otherwise null. */
export function readEntitlementSource(
  metadata: unknown,
): AddonEntitlementSource | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const v = (metadata as Record<string, unknown>).entitlementSource;
    if (v === "manual") return "manual";
    if (v === "stripe") return "stripe";
  }
  return null;
}

// ── Add-on Price ID mapping (server-side, env-backed) ───────────────────────
// SERVER-SIDE ONLY — never imported into client code. Lives here (not lib/stripe)
// so it stays free of DB imports and is unit-testable. lib/stripe re-exports
// these for the canonical Stripe surface.

/** The env var holding the Business Phone add-on monthly Price ID. */
export const BUSINESS_PHONE_ADDON_PRICE_ENV = "STRIPE_PRICE_BUSINESS_PHONE_MONTH";

/** Read the configured add-on Price ID, tolerating the `_MONTHLY` spelling the
 *  way lib/stripe.readEnvPrice does. Returns null when unset → feature DARK. */
export function businessPhoneAddonPriceId(): string | null {
  const direct = process.env[BUSINESS_PHONE_ADDON_PRICE_ENV];
  if (direct) return direct;
  const alt = process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`]; // _MONTH -> _MONTHLY
  return alt ? alt : null;
}

/** True iff `priceId` is the configured Business Phone add-on price. Fail-closed
 *  (false) when the add-on price isn't configured — keeps the feature dark. */
export function isBusinessPhoneAddonPrice(priceId: string | null | undefined): boolean {
  if (!priceId) return false;
  const configured = businessPhoneAddonPriceId();
  return Boolean(configured && configured === priceId);
}

/**
 * Generic first-match scan over a list of price ids using an injected resolver.
 * Returns the first non-null/non-false resolver result, else null. PURE — used
 * by the webhook's multi-item plan detection (lib/stripe.pickPlanFromPriceIds)
 * and unit-tested directly with a fake resolver.
 */
export function pickFirstMatch<T>(
  priceIds: Array<string | null | undefined>,
  resolve: (priceId: string | null | undefined) => T | null,
): T | null {
  for (const id of priceIds) {
    const hit = resolve(id);
    if (hit) return hit;
  }
  return null;
}
