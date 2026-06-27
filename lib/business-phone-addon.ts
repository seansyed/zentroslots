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

/** Whether the Stripe webhook recorded the add-on line item as present
 *  (metadata.businessPhoneAddon.subscribed === true). Used to distinguish a
 *  billing-suspended tenant from one that never subscribed. */
export function readAddonSubscribedFlag(metadata: unknown): boolean {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const a = (metadata as Record<string, unknown>).businessPhoneAddon;
    if (a && typeof a === "object" && !Array.isArray(a)) {
      return (a as Record<string, unknown>).subscribed === true;
    }
  }
  return false;
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

// ── Add / remove add-on action planner (Phase 2) ────────────────────────────
// PURE decision logic for POST /api/tenant/phone/addon. The route is a thin I/O
// shell: it loads the live Stripe subscription, calls planAddonAction() to
// decide WHAT to do, then performs the single Stripe mutation. Entitlement is
// NOT written here — the resulting customer.subscription.updated webhook syncs
// it (Phase 1). This keeps the decision unit-testable with synthetic items.

/** Subscription statuses on which we may add/remove an item (the base sub is
 *  live). Mirrors the add-on grace policy — `past_due` is still modifiable;
 *  canceled/unpaid/incomplete(_expired) are treated as "no active base". */
export const MODIFIABLE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "trialing",
  "past_due",
]);

export function isModifiableSubscriptionStatus(status: string | null | undefined): boolean {
  return MODIFIABLE_SUBSCRIPTION_STATUSES.has(String(status ?? "").toLowerCase().trim());
}

/** A live Stripe subscription line item (only the fields the planner needs). */
export type SubscriptionItemRef = { id: string; priceId: string | null | undefined };

export type AddonActionPlan =
  /** Add-on price not configured → feature dark; route returns 503, NO Stripe call. */
  | { kind: "disabled" }
  /** "add" but the tenant has no modifiable base subscription → 409. */
  | { kind: "no_subscription" }
  /** "add" and the add-on item is already present → idempotent success. */
  | { kind: "already_present" }
  /** "add": create one subscription item with this price on this subscription. */
  | { kind: "add"; priceId: string; subscriptionId: string }
  /** "remove" but the add-on item isn't present → idempotent success. */
  | { kind: "already_absent" }
  /** "remove": delete exactly this subscription item (never the base plan). */
  | { kind: "remove"; subscriptionItemId: string; subscriptionId: string };

/**
 * Decide the add/remove action. PURE + fail-closed. Scans ALL items (never
 * assumes items[0]) to find the add-on item via the injected predicate, and
 * never returns a plan that would touch a non-add-on (base plan) item.
 */
export function planAddonAction(input: {
  action: "add" | "remove";
  /** businessPhoneAddonPriceId() — null ⇒ feature dark. */
  addonPriceId: string | null;
  subscriptionId: string | null | undefined;
  subscriptionStatus: string | null | undefined;
  /** Live items from the Stripe subscription (empty when no subscription). */
  items: SubscriptionItemRef[];
  isAddonPrice: (priceId: string | null | undefined) => boolean;
}): AddonActionPlan {
  if (!input.addonPriceId) return { kind: "disabled" };

  // The add-on item, if present (scans every item — the base plan is ignored).
  const existing = (input.items ?? []).find((it) => input.isAddonPrice(it?.priceId));

  if (input.action === "remove") {
    if (!existing) return { kind: "already_absent" };
    return { kind: "remove", subscriptionItemId: existing.id, subscriptionId: input.subscriptionId! };
  }

  // action === "add"
  const hasActiveBase =
    Boolean(input.subscriptionId) && isModifiableSubscriptionStatus(input.subscriptionStatus);
  if (!hasActiveBase) return { kind: "no_subscription" };
  if (existing) return { kind: "already_present" };
  return { kind: "add", priceId: input.addonPriceId, subscriptionId: input.subscriptionId! };
}

/** Tenant-facing Business Phone setup state (Phase 2 prep; wired in Phase 4).
 *  Entitlement alone does NOT enable calls — a number must be assigned. */
export type BusinessPhoneSetupState = "not_entitled" | "setup_pending" | "ready";

export function businessPhoneSetupState(args: {
  entitled: boolean;
  numberAssigned: boolean;
}): BusinessPhoneSetupState {
  if (!args.entitled) return "not_entitled";
  return args.numberAssigned ? "ready" : "setup_pending";
}
