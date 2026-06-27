/**
 * Business Phone add-on — BILLING FOUNDATION (Phase 1). Pure-logic validation:
 * NO Stripe, NO DB, NO network. Proves the webhook-side entitlement decision is
 * fail-closed and billing-driven, the add-on price mapping stays dark until the
 * env var is set, the multi-item plan scan still finds the base plan, manual
 * pilots are never overwritten, and no secrets/softphone-claims leak.
 *
 * Run: `npx tsx --test tests/business-phone-addon.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveAddonEntitlement,
  shouldStripeWriteEntitlement,
  readEntitlementSource,
  ADDON_SUSPENDED_STATUSES,
  businessPhoneAddonPriceId,
  isBusinessPhoneAddonPrice,
  pickFirstMatch,
  BUSINESS_PHONE_ADDON_PRICE_ENV,
  planAddonAction,
  isModifiableSubscriptionStatus,
  MODIFIABLE_SUBSCRIPTION_STATUSES,
  businessPhoneSetupState,
} from "../lib/business-phone-addon";
import {
  SOFTPHONE_COMING_COPY,
  CLICK_TO_CALL_EXPLAINER,
  BUSINESS_PHONE_ADDON_CARD,
} from "../lib/business-phone-ui";

// ── fixtures ───────────────────────────────────────────────────────
const ADDON = "price_addon_biz_phone";
const PRO = "price_pro_monthly";
// Resolver injected into the pure resolveAddonEntitlement (the real env-backed
// predicate is isBusinessPhoneAddonPrice; tested separately below).
const isAddon = (p: string | null | undefined) => p === ADDON;

function items(...ids: Array<string | null | undefined>) {
  return ids.map((priceId) => ({ priceId }));
}

// ── entitlement resolution ─────────────────────────────────────────
test("add-on present + active subscription → subscribed + active", () => {
  const r = resolveAddonEntitlement({ items: items(PRO, ADDON), subscriptionStatus: "active", isAddonPrice: isAddon });
  assert.deepEqual(r, { subscribed: true, active: true });
});

test("add-on missing → not subscribed, not active (no accidental entitlement)", () => {
  const r = resolveAddonEntitlement({ items: items(PRO), subscriptionStatus: "active", isAddonPrice: isAddon });
  assert.deepEqual(r, { subscribed: false, active: false });
});

test("empty items → not subscribed, not active", () => {
  assert.deepEqual(
    resolveAddonEntitlement({ items: [], subscriptionStatus: "active", isAddonPrice: isAddon }),
    { subscribed: false, active: false },
  );
});

test("suspended statuses (canceled/unpaid/incomplete_expired) → subscribed but INACTIVE", () => {
  for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
    const r = resolveAddonEntitlement({ items: items(ADDON), subscriptionStatus: status, isAddonPrice: isAddon });
    assert.deepEqual(r, { subscribed: true, active: false }, `status=${status}`);
  }
});

test("past_due → STILL active (grace window, matches billing policy)", () => {
  const r = resolveAddonEntitlement({ items: items(ADDON), subscriptionStatus: "past_due", isAddonPrice: isAddon });
  assert.deepEqual(r, { subscribed: true, active: true });
});

test("trialing / active → active", () => {
  for (const status of ["trialing", "active"]) {
    assert.equal(resolveAddonEntitlement({ items: items(ADDON), subscriptionStatus: status, isAddonPrice: isAddon }).active, true);
  }
});

test("status match is case-insensitive and trimmed", () => {
  assert.equal(resolveAddonEntitlement({ items: items(ADDON), subscriptionStatus: " CANCELED ", isAddonPrice: isAddon }).active, false);
  assert.equal(resolveAddonEntitlement({ items: items(ADDON), subscriptionStatus: "Active", isAddonPrice: isAddon }).active, true);
});

test("the suspended-status set matches the billing policy exactly (past_due NOT included)", () => {
  assert.equal(ADDON_SUSPENDED_STATUSES.has("canceled"), true);
  assert.equal(ADDON_SUSPENDED_STATUSES.has("unpaid"), true);
  assert.equal(ADDON_SUSPENDED_STATUSES.has("incomplete_expired"), true);
  assert.equal(ADDON_SUSPENDED_STATUSES.has("past_due"), false);
  assert.equal(ADDON_SUSPENDED_STATUSES.has("active"), false);
});

// ── manual-source guard (docs-demo pilot protection) ───────────────
test("manual entitlement source is never overwritten by Stripe webhook logic", () => {
  assert.equal(shouldStripeWriteEntitlement("manual"), false);
  assert.equal(shouldStripeWriteEntitlement("stripe"), true);
  assert.equal(shouldStripeWriteEntitlement(null), true);
  assert.equal(shouldStripeWriteEntitlement(undefined), true);
});

test("readEntitlementSource reads the marker safely", () => {
  assert.equal(readEntitlementSource({ entitlementSource: "manual" }), "manual");
  assert.equal(readEntitlementSource({ entitlementSource: "stripe" }), "stripe");
  assert.equal(readEntitlementSource({ entitlementActive: true }), null);
  assert.equal(readEntitlementSource({}), null);
  assert.equal(readEntitlementSource(null), null);
  assert.equal(readEntitlementSource(undefined), null);
  assert.equal(readEntitlementSource([]), null);
  assert.equal(readEntitlementSource("manual"), null); // not an object → null
});

// ── multi-item plan scan (webhook must not assume items[0]) ─────────
test("pickFirstMatch returns the first recognized plan even when the add-on item sorts first", () => {
  // simulate planFromStripePriceId: only PRO maps to a plan; the add-on does not
  const planResolver = (p: string | null | undefined) =>
    p === PRO ? { plan: "pro" as const, interval: "month" as const } : null;
  // add-on item FIRST, base plan second — the scan must still find the plan
  assert.deepEqual(pickFirstMatch([ADDON, PRO], planResolver), { plan: "pro", interval: "month" });
  // base plan only
  assert.deepEqual(pickFirstMatch([PRO], planResolver), { plan: "pro", interval: "month" });
  // add-on only → no plan (webhook leaves currentPlan unchanged)
  assert.equal(pickFirstMatch([ADDON], planResolver), null);
  // nothing recognized
  assert.equal(pickFirstMatch([null, "price_unknown"], planResolver), null);
});

// ── add-on price mapping: DARK unless env set ──────────────────────
function withEnv(value: string | undefined, fn: () => void) {
  const prev = process.env[BUSINESS_PHONE_ADDON_PRICE_ENV];
  const prevAlt = process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`];
  try {
    delete process.env[BUSINESS_PHONE_ADDON_PRICE_ENV];
    delete process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`];
    if (value !== undefined) process.env[BUSINESS_PHONE_ADDON_PRICE_ENV] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[BUSINESS_PHONE_ADDON_PRICE_ENV];
    else process.env[BUSINESS_PHONE_ADDON_PRICE_ENV] = prev;
    if (prevAlt === undefined) delete process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`];
    else process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`] = prevAlt;
  }
}

test("feature is DARK when STRIPE_PRICE_BUSINESS_PHONE_MONTH is unset", () => {
  withEnv(undefined, () => {
    assert.equal(businessPhoneAddonPriceId(), null);
    assert.equal(isBusinessPhoneAddonPrice(ADDON), false);
    assert.equal(isBusinessPhoneAddonPrice("price_anything"), false);
  });
});

test("add-on price resolves and matches ONLY the configured id when env is set", () => {
  withEnv(ADDON, () => {
    assert.equal(businessPhoneAddonPriceId(), ADDON);
    assert.equal(isBusinessPhoneAddonPrice(ADDON), true);
    assert.equal(isBusinessPhoneAddonPrice("price_other"), false);
    assert.equal(isBusinessPhoneAddonPrice(null), false);
    assert.equal(isBusinessPhoneAddonPrice(undefined), false);
  });
});

test("tolerates the _MONTHLY spelling fallback", () => {
  const prev = process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`];
  const prevDirect = process.env[BUSINESS_PHONE_ADDON_PRICE_ENV];
  try {
    delete process.env[BUSINESS_PHONE_ADDON_PRICE_ENV];
    process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`] = ADDON;
    assert.equal(businessPhoneAddonPriceId(), ADDON);
  } finally {
    if (prev === undefined) delete process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`];
    else process.env[`${BUSINESS_PHONE_ADDON_PRICE_ENV}LY`] = prev;
    if (prevDirect !== undefined) process.env[BUSINESS_PHONE_ADDON_PRICE_ENV] = prevDirect;
  }
});

// ── no secret leakage ──────────────────────────────────────────────
test("resolver output exposes only {subscribed, active} — no secrets/extra fields", () => {
  const r = resolveAddonEntitlement({ items: items(ADDON), subscriptionStatus: "active", isAddonPrice: isAddon });
  assert.deepEqual(Object.keys(r).sort(), ["active", "subscribed"]);
});

test("add-on price id is a Stripe price ref, never an API key/secret", () => {
  withEnv(ADDON, () => {
    const id = businessPhoneAddonPriceId() ?? "";
    assert.match(id, /^price_/); // Stripe Price IDs only
    assert.doesNotMatch(id, /sk_/i); // never a secret key
    assert.doesNotMatch(id, /KEY[0-9A-F]/); // never a Telnyx API key
    assert.doesNotMatch(id, /whsec_/i); // never a webhook secret
  });
});

// ── public copy must not claim the softphone is available ──────────
test("softphone copy says coming soon / not available — never claims it's live", () => {
  assert.match(SOFTPHONE_COMING_COPY, /coming/i);
  assert.match(SOFTPHONE_COMING_COPY, /not available yet/i);
  assert.doesNotMatch(SOFTPHONE_COMING_COPY, /available now/i);
  // Click-to-call is explicitly NOT a browser softphone.
  assert.match(CLICK_TO_CALL_EXPLAINER, /not in the browser|phone first/i);
});

test("add-on card copy is honest: $19, 200 min, no emergency/intl, softphone coming soon", () => {
  assert.equal(BUSINESS_PHONE_ADDON_CARD.price, "$19/month");
  const blob = JSON.stringify(BUSINESS_PHONE_ADDON_CARD).toLowerCase();
  assert.match(blob, /200 us & canada minutes/);
  assert.match(blob, /softphone — coming soon|softphone .* coming soon/);
  assert.match(blob, /no emergency/);
  assert.match(blob, /no international/);
  // never claims a working/available softphone
  assert.doesNotMatch(blob, /softphone (now|available|included|ready)/);
});

// ════════════════════════════════════════════════════════════════════
// Phase 2 — add/remove add-on ACTION PLANNER (pure decision logic)
// ════════════════════════════════════════════════════════════════════
const ADDON_PRICE = "price_addon_biz_phone";
const isAddonReal = (p: string | null | undefined) => p === ADDON_PRICE;
const baseItem = { id: "si_base", priceId: "price_pro_monthly" };
const addonItem = { id: "si_addon", priceId: ADDON_PRICE };

test("add: DISABLED when add-on price is unset → no Stripe call (route returns 503)", () => {
  const plan = planAddonAction({
    action: "add",
    addonPriceId: null,
    subscriptionId: "sub_1",
    subscriptionStatus: "active",
    items: [baseItem],
    isAddonPrice: isAddonReal,
  });
  assert.deepEqual(plan, { kind: "disabled" });
});

test("remove: DISABLED when add-on price is unset (dark) → no Stripe call", () => {
  assert.deepEqual(
    planAddonAction({ action: "remove", addonPriceId: null, subscriptionId: "sub_1", subscriptionStatus: "active", items: [addonItem], isAddonPrice: isAddonReal }),
    { kind: "disabled" },
  );
});

test("add: no active base subscription → no_subscription (route 409)", () => {
  // no subscription at all
  assert.deepEqual(
    planAddonAction({ action: "add", addonPriceId: ADDON_PRICE, subscriptionId: null, subscriptionStatus: null, items: [], isAddonPrice: isAddonReal }),
    { kind: "no_subscription" },
  );
  // subscription exists but is canceled/unpaid/incomplete → not modifiable
  for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired"]) {
    assert.deepEqual(
      planAddonAction({ action: "add", addonPriceId: ADDON_PRICE, subscriptionId: "sub_1", subscriptionStatus: status, items: [baseItem], isAddonPrice: isAddonReal }),
      { kind: "no_subscription" },
      `status=${status}`,
    );
  }
});

test("add: idempotent when add-on already present → already_present (no second item)", () => {
  assert.deepEqual(
    planAddonAction({ action: "add", addonPriceId: ADDON_PRICE, subscriptionId: "sub_1", subscriptionStatus: "active", items: [baseItem, addonItem], isAddonPrice: isAddonReal }),
    { kind: "already_present" },
  );
});

test("add: creates exactly one item when missing (on the existing subscription)", () => {
  assert.deepEqual(
    planAddonAction({ action: "add", addonPriceId: ADDON_PRICE, subscriptionId: "sub_1", subscriptionStatus: "active", items: [baseItem], isAddonPrice: isAddonReal }),
    { kind: "add", priceId: ADDON_PRICE, subscriptionId: "sub_1" },
  );
});

test("add: works while past_due (grace) — base sub still modifiable", () => {
  assert.deepEqual(
    planAddonAction({ action: "add", addonPriceId: ADDON_PRICE, subscriptionId: "sub_1", subscriptionStatus: "past_due", items: [baseItem], isAddonPrice: isAddonReal }),
    { kind: "add", priceId: ADDON_PRICE, subscriptionId: "sub_1" },
  );
});

test("remove: idempotent when add-on not present → already_absent", () => {
  assert.deepEqual(
    planAddonAction({ action: "remove", addonPriceId: ADDON_PRICE, subscriptionId: "sub_1", subscriptionStatus: "active", items: [baseItem], isAddonPrice: isAddonReal }),
    { kind: "already_absent" },
  );
  // no subscription at all → also idempotent success
  assert.deepEqual(
    planAddonAction({ action: "remove", addonPriceId: ADDON_PRICE, subscriptionId: null, subscriptionStatus: null, items: [], isAddonPrice: isAddonReal }),
    { kind: "already_absent" },
  );
});

test("remove: deletes ONLY the add-on item, never the base plan", () => {
  const plan = planAddonAction({ action: "remove", addonPriceId: ADDON_PRICE, subscriptionId: "sub_1", subscriptionStatus: "active", items: [baseItem, addonItem], isAddonPrice: isAddonReal });
  assert.deepEqual(plan, { kind: "remove", subscriptionItemId: "si_addon", subscriptionId: "sub_1" });
  // explicitly NOT the base plan's item id
  assert.notEqual((plan as { subscriptionItemId: string }).subscriptionItemId, "si_base");
});

test("planner scans ALL items, not items[0] (add-on in a later slot)", () => {
  const itemsAddonLast = [baseItem, { id: "si_x", priceId: "price_other" }, addonItem];
  // remove finds it at index 2
  assert.equal(
    (planAddonAction({ action: "remove", addonPriceId: ADDON_PRICE, subscriptionId: "sub_1", subscriptionStatus: "active", items: itemsAddonLast, isAddonPrice: isAddonReal }) as { subscriptionItemId?: string }).subscriptionItemId,
    "si_addon",
  );
  // add sees it as already present
  assert.equal(
    planAddonAction({ action: "add", addonPriceId: ADDON_PRICE, subscriptionId: "sub_1", subscriptionStatus: "active", items: itemsAddonLast, isAddonPrice: isAddonReal }).kind,
    "already_present",
  );
});

test("modifiable-status set: active/trialing/past_due yes; canceled/unpaid/incomplete no", () => {
  assert.equal(isModifiableSubscriptionStatus("active"), true);
  assert.equal(isModifiableSubscriptionStatus("trialing"), true);
  assert.equal(isModifiableSubscriptionStatus("past_due"), true);
  assert.equal(isModifiableSubscriptionStatus("canceled"), false);
  assert.equal(isModifiableSubscriptionStatus("unpaid"), false);
  assert.equal(isModifiableSubscriptionStatus("incomplete_expired"), false);
  assert.equal(isModifiableSubscriptionStatus(null), false);
  assert.equal(isModifiableSubscriptionStatus(" ACTIVE "), true); // case/space tolerant
  assert.equal(MODIFIABLE_SUBSCRIPTION_STATUSES.has("active"), true);
});

// ── setup state (entitlement ≠ ready until a number is assigned) ────
test("setup state: buying add-on without a number = setup_pending, not ready", () => {
  assert.equal(businessPhoneSetupState({ entitled: false, numberAssigned: false }), "not_entitled");
  assert.equal(businessPhoneSetupState({ entitled: true, numberAssigned: false }), "setup_pending");
  assert.equal(businessPhoneSetupState({ entitled: true, numberAssigned: true }), "ready");
});

// ── route contract (source-level guards; no DB/Stripe needed) ──────
test("addon route is admin-only, webhook-driven, fail-closed, and proration-explicit", () => {
  const src = readFileSync(join(process.cwd(), "app/api/tenant/phone/addon/route.ts"), "utf8");
  // admin-only — never widened to manager/staff
  assert.match(src, /requireRole\(\["admin"\]\)/);
  assert.doesNotMatch(src, /requireRole\(\[[^\]]*"(manager|staff)"/);
  // dark guard precedes any Stripe API call
  const darkGuardIdx = src.indexOf("isn't available yet");
  const retrieveIdx = src.indexOf("subscriptions.retrieve");
  assert.ok(darkGuardIdx > -1 && retrieveIdx > -1 && darkGuardIdx < retrieveIdx, "503 dark guard must precede subscriptions.retrieve");
  // 409 message + explicit proration
  assert.match(src, /Subscribe to a base plan first\./);
  assert.match(src, /proration_behavior:\s*"none"/);
  // entitlement is webhook-driven — route must NOT write tenant_phone_settings
  assert.doesNotMatch(src, /tenantPhoneSettings/);
  assert.doesNotMatch(src, /entitlementActive/);
});
