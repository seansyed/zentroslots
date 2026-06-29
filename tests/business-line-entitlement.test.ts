/**
 * Business Line entitlement / add-on gating (increment 6). Pure tests for the
 * real two-gate model (plan + add-on), the PATCH gate, the UI copy, and the
 * plan-tier behavior the route's plan gate relies on. Composes with
 * decideForwarding to prove forwarding is rejected when locked. No DB / Stripe /
 * Telnyx — the plan tier is exercised via the pure lib/plans helpers.
 *
 * Run: `npx tsx --test tests/business-line-entitlement.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveBusinessLineEntitlement,
  readAddonActiveFlag,
  businessLineAddonCopy,
  evaluateBusinessLinePatchGate,
} from "../lib/business-line-view";
import { getPlan, meetsPlan } from "../lib/plans";
import { decideForwarding, type ForwardingContext } from "../lib/business-line-forwarding";

// ── two-gate entitlement ───────────────────────────────────────────
test("entitlement is LOCKED unless plan eligible AND add-on active", () => {
  // plan not eligible → locked, reason plan_not_eligible
  const noPlan = resolveBusinessLineEntitlement({ planEligible: false, addonActive: true });
  assert.equal(noPlan.active, false);
  assert.equal(noPlan.locked, true);
  assert.equal(noPlan.reason, "plan_not_eligible");

  // plan eligible but add-on inactive → locked, reason addon_inactive
  const noAddon = resolveBusinessLineEntitlement({ planEligible: true, addonActive: false });
  assert.equal(noAddon.active, false);
  assert.equal(noAddon.locked, true);
  assert.equal(noAddon.reason, "addon_inactive");

  // both → active
  const ok = resolveBusinessLineEntitlement({ planEligible: true, addonActive: true });
  assert.equal(ok.active, true);
  assert.equal(ok.locked, false);
  assert.equal(ok.reason, "active");
});

test("entitlement carries included minutes (1,000) + $29/mo price + Pro requirement", () => {
  const e = resolveBusinessLineEntitlement({ planEligible: true, addonActive: true });
  assert.equal(e.includedMinutes, 1000);
  assert.equal(e.hardCapMinutes, 1000);
  assert.equal(e.monthlyPriceCents, 2900);
  assert.equal(e.requiredPlan, "pro");
});

test("readAddonActiveFlag only true for an explicit metadata flag", () => {
  assert.equal(readAddonActiveFlag({ entitlementActive: true }), true);
  assert.equal(readAddonActiveFlag({ entitlementActive: false }), false);
  assert.equal(readAddonActiveFlag({}), false);
  assert.equal(readAddonActiveFlag(null), false);
  assert.equal(readAddonActiveFlag(undefined), false);
});

// ── UI copy ────────────────────────────────────────────────────────
test("businessLineAddonCopy renders $29/month + 1,000 minutes + reason", () => {
  const locked = businessLineAddonCopy(resolveBusinessLineEntitlement({ planEligible: false, addonActive: false }));
  assert.equal(locked.title, "Business Line add-on");
  assert.equal(locked.price, "$29/month");
  assert.equal(locked.minutes, "1,000 US/Canada minutes");
  assert.match(locked.reasonText, /Pro and above/);

  const addonInactive = businessLineAddonCopy(resolveBusinessLineEntitlement({ planEligible: true, addonActive: false }));
  assert.match(addonInactive.reasonText, /add-on/i);

  const active = businessLineAddonCopy(resolveBusinessLineEntitlement({ planEligible: true, addonActive: true }));
  assert.equal(active.reasonText, "Active.");
});

// ── PATCH gate ─────────────────────────────────────────────────────
test("PATCH gate: active allows anything", () => {
  assert.deepEqual(
    evaluateBusinessLinePatchGate({ entitlementActive: true, setsEnabledTrue: true, setsNonEmptyForwarding: true }),
    { allowed: true },
  );
});

test("PATCH gate: locked blocks enabling / setting a number", () => {
  const enable = evaluateBusinessLinePatchGate({ entitlementActive: false, setsEnabledTrue: true, setsNonEmptyForwarding: false });
  assert.equal(enable.allowed, false);
  const setNumber = evaluateBusinessLinePatchGate({ entitlementActive: false, setsEnabledTrue: false, setsNonEmptyForwarding: true });
  assert.equal(setNumber.allowed, false);
});

test("PATCH gate: locked still allows disabling / clearing", () => {
  assert.deepEqual(
    evaluateBusinessLinePatchGate({ entitlementActive: false, setsEnabledTrue: false, setsNonEmptyForwarding: false }),
    { allowed: true },
  );
});

// ── plan tier behavior (the route's plan gate uses meetsPlan via canUse) ──
test("plan gate: Pro+ eligible, Free/Solo not (business_line requires pro)", () => {
  assert.equal(meetsPlan(getPlan("free").id, "pro"), false);
  assert.equal(meetsPlan(getPlan("solo").id, "pro"), false);
  assert.equal(meetsPlan(getPlan("pro").id, "pro"), true);
  assert.equal(meetsPlan(getPlan("team").id, "pro"), true);
  assert.equal(meetsPlan(getPlan("enterprise").id, "pro"), true);
});

// ── forwarding rejected when locked ────────────────────────────────
test("forwarding is rejected when entitlement is locked", () => {
  const base: ForwardingContext = {
    tenantMatched: true,
    businessNumber: "+14155550100",
    ownedNumbers: ["+14155550100"],
    settingsEnabled: true,
    entitlementActive: resolveBusinessLineEntitlement({ planEligible: true, addonActive: false }).active, // false
    forwardingNumber: "+16475550123",
    minutesUsed: 0,
    monthlyMinuteCap: 200,
  };
  assert.deepEqual(decideForwarding(base), { action: "reject", reason: "no_entitlement" });

  // and granted when both gates pass
  const granted = decideForwarding({
    ...base,
    entitlementActive: resolveBusinessLineEntitlement({ planEligible: true, addonActive: true }).active, // true
  });
  assert.equal(granted.action, "dial");
});
