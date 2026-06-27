/**
 * Mobile Business Phone helpers (P1.3). Pure tests — NO React, NO network.
 * Pins the Phone-tab gating, US/Canada dial validation, keypad rules, dial
 * preview, and error/success copy the Phone screen relies on.
 *
 * Run: `npx tsx --test tests/businessPhone.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldShowPhoneTab,
  canShowCustomerCallButton,
  canCallCustomerViaBusinessPhone,
  validateDialInput,
  dialPreview,
  formatNanpForDisplay,
  isSupportedKeypadKey,
  buildCallBackPayload,
  phoneCallErrorMessage,
  OUTBOUND_CALL_SUCCESS_MESSAGE,
} from "../src/lib/businessPhone";

// ── tab visibility ──
test("Phone tab visible only when entitled AND hasPhoneAccess", () => {
  assert.equal(shouldShowPhoneTab({ entitled: true, hasPhoneAccess: true }), true);
  assert.equal(shouldShowPhoneTab({ entitled: true, hasPhoneAccess: false }), false);
  assert.equal(shouldShowPhoneTab({ entitled: false, hasPhoneAccess: true }), false);
  assert.equal(shouldShowPhoneTab({ entitled: false, hasPhoneAccess: false }), false);
  // fail-closed on missing/unknown
  assert.equal(shouldShowPhoneTab(null), false);
  assert.equal(shouldShowPhoneTab(undefined), false);
  assert.equal(shouldShowPhoneTab({}), false);
});

// ── customer call action (for P1.3.1 wiring) ──
test("customer call action requires entitled + canPlaceCalls + a phone", () => {
  assert.equal(canShowCustomerCallButton({ entitled: true, canPlaceCalls: true, phone: "+14155550182" }), true);
  assert.equal(canShowCustomerCallButton({ entitled: true, canPlaceCalls: false, phone: "+14155550182" }), false);
  assert.equal(canShowCustomerCallButton({ entitled: true, canPlaceCalls: true, phone: null }), false);
  assert.equal(canShowCustomerCallButton({ entitled: false, canPlaceCalls: true, phone: "+14155550182" }), false);
});

// ── customer-detail "Call via Business Phone" gate (P1.3.1) ──
test("customer call action shown only when fully entitled + valid US/CA phone", () => {
  const ok = { entitled: true, hasPhoneAccess: true, canPlaceCalls: true };
  const phone = "+14155550182";
  assert.equal(canCallCustomerViaBusinessPhone(ok, phone), true);
  // hidden when not entitled
  assert.equal(canCallCustomerViaBusinessPhone({ ...ok, entitled: false }, phone), false);
  // hidden when no phone access
  assert.equal(canCallCustomerViaBusinessPhone({ ...ok, hasPhoneAccess: false }, phone), false);
  // hidden when cannot place calls
  assert.equal(canCallCustomerViaBusinessPhone({ ...ok, canPlaceCalls: false }, phone), false);
  // hidden when customer has no phone
  assert.equal(canCallCustomerViaBusinessPhone(ok, null), false);
  assert.equal(canCallCustomerViaBusinessPhone(ok, "   "), false);
  // hidden when customer phone is invalid / international / emergency
  assert.equal(canCallCustomerViaBusinessPhone(ok, "+1555"), false);
  assert.equal(canCallCustomerViaBusinessPhone(ok, "+447911123456"), false);
  assert.equal(canCallCustomerViaBusinessPhone(ok, "911"), false);
  // fail-closed on missing businessPhone snapshot
  assert.equal(canCallCustomerViaBusinessPhone(null, phone), false);
  assert.equal(canCallCustomerViaBusinessPhone(undefined, phone), false);
});

// ── dial validation (call button disabled until valid) ──
test("validateDialInput rejects empty / emergency / international / malformed", () => {
  assert.equal(validateDialInput("").ok, false);
  assert.equal(validateDialInput("   ").ok, false);
  assert.equal(validateDialInput("911").ok, false);
  assert.equal(validateDialInput("411").ok, false);
  assert.equal(validateDialInput("+447911123456").ok, false); // UK
  assert.equal(validateDialInput("+1555").ok, false);
  const ok = validateDialInput("(415) 555-0182");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.e164, "+14155550182");
});

test("validateDialInput error copy", () => {
  assert.match((validateDialInput("") as { message: string }).message, /Enter a phone number/i);
  assert.match((validateDialInput("911") as { message: string }).message, /Emergency/i);
  assert.match((validateDialInput("+447911123456") as { message: string }).message, /US and Canada/i);
});

// ── keypad: no * / # ──
test("keypad does not support * or #", () => {
  assert.equal(isSupportedKeypadKey("1"), true);
  assert.equal(isSupportedKeypadKey("0"), true);
  assert.equal(isSupportedKeypadKey("*"), false);
  assert.equal(isSupportedKeypadKey("#"), false);
});

// ── dial preview ──
test("dial preview formats valid NANP, else null", () => {
  assert.equal(dialPreview("4155550182"), "+1 (415) 555-0182");
  assert.equal(dialPreview("+14155550182"), "+1 (415) 555-0182");
  assert.equal(dialPreview("+1555"), null);
  assert.equal(dialPreview(""), null);
  assert.equal(formatNanpForDisplay("+14155550182"), "+1 (415) 555-0182");
});

// ── call-back payload ──
test("buildCallBackPayload targets the missed caller", () => {
  assert.deepEqual(buildCallBackPayload("+14155550182"), {
    toNumber: "+14155550182",
    callPurpose: "callback_missed",
  });
  assert.equal(buildCallBackPayload(null), null);
  assert.equal(buildCallBackPayload("  "), null);
});

// ── error/success copy ──
test("phoneCallErrorMessage matches web copy per status", () => {
  assert.equal(phoneCallErrorMessage(402, "X"), "X"); // prefers server message
  assert.match(phoneCallErrorMessage(402), /add-on isn't active/i);
  assert.match(phoneCallErrorMessage(403), /permission to place Business Phone calls/i);
  assert.match(phoneCallErrorMessage(429), /Too many calls/i);
  assert.match(phoneCallErrorMessage(503), /temporarily unavailable/i);
  assert.match(phoneCallErrorMessage(409), /Check the number/i);
  assert.match(phoneCallErrorMessage(400), /Check the number/i);
  assert.match(phoneCallErrorMessage(500), /try again/i);
});

test("success message sets the bridge expectation", () => {
  assert.match(OUTBOUND_CALL_SUCCESS_MESSAGE, /calling your phone first/i);
});

// ── setup_required copy surfaces (server message) ──
test("setup_required server copy passes through", () => {
  const serverMsg = "Set your calling phone number first. ZentroMeet will call you there, then connect the customer.";
  assert.equal(phoneCallErrorMessage(409, serverMsg), serverMsg);
});
