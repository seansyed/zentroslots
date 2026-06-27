/**
 * Super-admin Business Phone provisioning — Phase 3. Pure-logic validation +
 * route source-contract guards. NO DB, NO Telnyx, NO Stripe, NO network. Proves
 * the assign/toggle/pending decisions are fail-closed and that the routes are
 * super-admin-only, never call Telnyx, never auto-provision, never write
 * entitlement, and never leak secrets.
 *
 * Run: `npx tsx --test tests/business-phone-admin.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  validateAssignInput,
  classifyNumberAssignment,
  resolveBusinessPhoneSetupState,
  isSuspendedSubscriptionStatus,
  assignEnabledState,
  canManuallyEnable,
} from "../lib/business-phone-admin";

const BIZ = "+14155550123";
const FWD = "+16475550123";

// ── validateAssignInput ─────────────────────────────────────────────
test("valid US/CA business + forwarding numbers → normalized E.164, default 200 min", () => {
  const v = validateAssignInput({ businessPhoneNumber: "(415) 555-0123", forwardingNumber: "647-555-0123" });
  assert.deepEqual(v, { ok: true, businessE164: BIZ, forwardingE164: FWD, includedMinutes: 200 });
});

test("included-minutes override is honored; invalid values rejected", () => {
  assert.equal(validateAssignInput({ businessPhoneNumber: BIZ, forwardingNumber: FWD, includedMinutes: 500 }).ok && true, true);
  const ok = validateAssignInput({ businessPhoneNumber: BIZ, forwardingNumber: FWD, includedMinutes: 500 });
  assert.equal(ok.ok && ok.includedMinutes, 500);
  const bad = validateAssignInput({ businessPhoneNumber: BIZ, forwardingNumber: FWD, includedMinutes: -5 });
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.field, "includedMinutes");
});

test("rejects emergency/N11, international, malformed, and empty numbers", () => {
  const emer = validateAssignInput({ businessPhoneNumber: "911", forwardingNumber: FWD });
  assert.equal(emer.ok, false);
  assert.equal(emer.ok === false && emer.field, "businessPhoneNumber");
  assert.match((emer as { reason: string }).reason, /emergency/i);

  const intl = validateAssignInput({ businessPhoneNumber: "+447911123456", forwardingNumber: FWD });
  assert.equal(intl.ok, false);
  assert.match((intl as { reason: string }).reason, /US & Canada/i);

  const malformed = validateAssignInput({ businessPhoneNumber: "+1555", forwardingNumber: FWD });
  assert.equal(malformed.ok, false);

  const empty = validateAssignInput({ businessPhoneNumber: "", forwardingNumber: FWD });
  assert.equal(empty.ok, false);

  // emergency in the forwarding slot is also caught
  const fEmer = validateAssignInput({ businessPhoneNumber: BIZ, forwardingNumber: "411" });
  assert.equal(fEmer.ok === false && fEmer.field, "forwardingNumber");
});

test("forwarding number must differ from the business number", () => {
  const v = validateAssignInput({ businessPhoneNumber: BIZ, forwardingNumber: BIZ });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.field, "forwardingNumber");
});

// ── duplicate-number classification ─────────────────────────────────
test("classifyNumberAssignment: insert / reactivate / conflict_active / conflict_other", () => {
  assert.equal(classifyNumberAssignment(null, "t1"), "insert");
  assert.equal(classifyNumberAssignment({ tenantId: "t1", status: "released" }, "t1"), "reactivate");
  assert.equal(classifyNumberAssignment({ tenantId: "t1", status: "active" }, "t1"), "reactivate");
  assert.equal(classifyNumberAssignment({ tenantId: "t2", status: "active" }, "t1"), "conflict_active");
  assert.equal(classifyNumberAssignment({ tenantId: "t2", status: "released" }, "t1"), "conflict_other");
});

// ── setup state machine ─────────────────────────────────────────────
test("resolveBusinessPhoneSetupState precedence", () => {
  assert.equal(resolveBusinessPhoneSetupState({ entitled: true, numberAssigned: true, settingsEnabled: true, suspended: true }), "suspended");
  assert.equal(resolveBusinessPhoneSetupState({ entitled: false, numberAssigned: false, settingsEnabled: true }), "no_addon");
  assert.equal(resolveBusinessPhoneSetupState({ entitled: true, numberAssigned: true, settingsEnabled: false }), "disabled");
  assert.equal(resolveBusinessPhoneSetupState({ entitled: true, numberAssigned: false, settingsEnabled: true }), "setup_pending");
  assert.equal(resolveBusinessPhoneSetupState({ entitled: true, numberAssigned: true, settingsEnabled: true, capReached: true }), "cap_reached");
  assert.equal(resolveBusinessPhoneSetupState({ entitled: true, numberAssigned: true, settingsEnabled: true }), "active");
});

test("isSuspendedSubscriptionStatus mirrors the add-on suspension policy", () => {
  assert.equal(isSuspendedSubscriptionStatus("canceled"), true);
  assert.equal(isSuspendedSubscriptionStatus("unpaid"), true);
  assert.equal(isSuspendedSubscriptionStatus("incomplete_expired"), true);
  assert.equal(isSuspendedSubscriptionStatus("past_due"), false);
  assert.equal(isSuspendedSubscriptionStatus("active"), false);
  assert.equal(isSuspendedSubscriptionStatus(null), false);
});

// ── enable rules ────────────────────────────────────────────────────
test("assignEnabledState: only when entitled/manual AND both numbers present", () => {
  assert.equal(assignEnabledState({ entitledOrManual: true, hasBusinessNumber: true, hasForwarding: true }), true);
  assert.equal(assignEnabledState({ entitledOrManual: false, hasBusinessNumber: true, hasForwarding: true }), false);
  assert.equal(assignEnabledState({ entitledOrManual: true, hasBusinessNumber: false, hasForwarding: true }), false);
  assert.equal(assignEnabledState({ entitledOrManual: true, hasBusinessNumber: true, hasForwarding: false }), false);
});

test("canManuallyEnable requires entitlement/manual AND an assigned number", () => {
  assert.equal(canManuallyEnable({ entitledOrManual: true, numberAssigned: true }), true);
  assert.equal(canManuallyEnable({ entitledOrManual: false, numberAssigned: true }), false);
  assert.equal(canManuallyEnable({ entitledOrManual: true, numberAssigned: false }), false);
});

// ── route source-contract guards (no DB/Stripe/Telnyx needed) ───────
const ROUTE_DIR = "app/api/admin/business-phone";
function routeSrc(name: string): string {
  return readFileSync(join(process.cwd(), ROUTE_DIR, name, "route.ts"), "utf8");
}

test("all admin routes are super-admin gated and never expose secrets", () => {
  for (const name of ["pending", "assign", "toggle"]) {
    const src = routeSrc(name);
    assert.match(src, /requireSuperAdmin\(\)/, `${name}: must gate on requireSuperAdmin`);
    // never reference secret material
    assert.doesNotMatch(src, /apiKey|STRIPE_SECRET_KEY|TELNYX_API_KEY|publicKey|whsec_|sk_live|sk_test/i, `${name}: no secrets`);
  }
});

test("assign route: validates input, classifies dup, NEVER calls Telnyx or writes entitlement", () => {
  const src = routeSrc("assign");
  assert.match(src, /validateAssignInput/);
  assert.match(src, /classifyNumberAssignment/);
  // conflict handling present
  assert.match(src, /already assigned to another tenant/);
  // no Telnyx API import / no auto-provision / no network call ("Telnyx" in
  // comments is fine — we check imports + call sites, not the word)
  assert.doesNotMatch(src, /from ["']@\/lib\/telnyx/);
  assert.doesNotMatch(src, /\bfetch\(/);
  assert.doesNotMatch(src, /originateBridgeCall/);
  // entitlement stays webhook-driven — route must not write the flag
  assert.doesNotMatch(src, /entitlementActive/);
});

test("toggle route: enable-gated, and disable never deletes numbers or logs", () => {
  const src = routeSrc("toggle");
  assert.match(src, /canManuallyEnable/);
  // disable just flips the flag — never deletes rows, never calls Telnyx
  assert.doesNotMatch(src, /\.delete\(/);
  assert.doesNotMatch(src, /from ["']@\/lib\/telnyx/);
});

test("pending route: filters to entitled tenants without an active number", () => {
  const src = routeSrc("pending");
  assert.match(src, /canUseBusinessLine/);
  assert.match(src, /readAddonActiveFlag/);
  assert.match(src, /hasActiveNumber/);
  assert.doesNotMatch(src, /from ["']@\/lib\/telnyx/);
});
