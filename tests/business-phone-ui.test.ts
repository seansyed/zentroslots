/**
 * Business Phone web UI — pure helper validation (P1.2). NO React, NO DB, NO
 * network. Covers the gating + dial validation + call-back payload + error
 * mapping that the Phone module, sidebar, and customer drawer rely on.
 *
 * Run: `npx tsx --test tests/business-phone-ui.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  shouldShowPhoneNav,
  canShowCustomerCallButton,
  validateDialInput,
  buildCallBackPayload,
  phoneCallErrorMessage,
  OUTBOUND_CALL_SUCCESS_MESSAGE,
  isSupportedKeypadKey,
  dialPreview,
  formatNanpForDisplay,
} from "../lib/business-phone-ui";

// ── sidebar / page visibility ──────────────────────────────────────
test("Phone nav: operators when entitled; staff only with access; hidden otherwise", () => {
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "admin" }), true);
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "manager" }), true);
  // staff need granted Business Phone access
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "staff", hasPhoneAccess: true }), true);
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "staff", hasPhoneAccess: false }), false);
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "staff" }), false); // missing flag → hidden
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "client", hasPhoneAccess: true }), false);
  // not subscribed → hidden for everyone
  assert.equal(shouldShowPhoneNav({ entitled: false, role: "admin" }), false);
  assert.equal(shouldShowPhoneNav({ entitled: false, role: "staff", hasPhoneAccess: true }), false);
});

// ── customer call button ───────────────────────────────────────────
test("customer call button: entitled AND canPlaceCalls AND a phone", () => {
  assert.equal(canShowCustomerCallButton({ entitled: true, canPlaceCalls: true, phone: "+14155550182" }), true);
  // staff without permission to place calls → hidden
  assert.equal(canShowCustomerCallButton({ entitled: true, canPlaceCalls: false, phone: "+14155550182" }), false);
  assert.equal(canShowCustomerCallButton({ entitled: true, canPlaceCalls: true, phone: null }), false);
  assert.equal(canShowCustomerCallButton({ entitled: true, canPlaceCalls: true, phone: "   " }), false);
  assert.equal(canShowCustomerCallButton({ entitled: false, canPlaceCalls: true, phone: "+14155550182" }), false);
});

// ── dial pad ───────────────────────────────────────────────────────
test("keypad does not insert unsupported * or # (US/CA only)", () => {
  assert.equal(isSupportedKeypadKey("1"), true);
  assert.equal(isSupportedKeypadKey("0"), true);
  assert.equal(isSupportedKeypadKey("*"), false);
  assert.equal(isSupportedKeypadKey("#"), false);
});

test("dial preview formats a valid NANP number, else null", () => {
  assert.equal(dialPreview("4155550182"), "+1 (415) 555-0182");
  assert.equal(dialPreview("+14155550182"), "+1 (415) 555-0182");
  assert.equal(dialPreview("+1555"), null);
  assert.equal(dialPreview(""), null);
  assert.equal(dialPreview("911"), null);
  assert.equal(formatNanpForDisplay("+14155550182"), "+1 (415) 555-0182");
});

// ── New Call form validation ───────────────────────────────────────
test("validateDialInput rejects empty / emergency / international / malformed", () => {
  const empty = validateDialInput("");
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false && empty.reason, "empty");

  assert.equal(validateDialInput("911").ok, false);
  assert.equal(validateDialInput("411").ok, false);
  assert.equal(validateDialInput("+447911123456").ok, false); // UK
  assert.equal(validateDialInput("+1555").ok, false); // malformed NANP

  const ok = validateDialInput("(415) 555-0182");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.e164, "+14155550182");
});

test("validateDialInput surfaces a human message for each failure", () => {
  assert.match((validateDialInput("") as { message: string }).message, /Enter a phone number/i);
  assert.match((validateDialInput("911") as { message: string }).message, /Emergency/i);
  assert.match((validateDialInput("+447911123456") as { message: string }).message, /US and Canada/i);
});

// ── Call Back payload ──────────────────────────────────────────────
test("buildCallBackPayload targets the missed caller with callback_missed", () => {
  assert.deepEqual(buildCallBackPayload("+14155550182"), {
    toNumber: "+14155550182",
    callPurpose: "callback_missed",
  });
  assert.equal(buildCallBackPayload(null), null);
  assert.equal(buildCallBackPayload("   "), null);
});

// ── error mapping ──────────────────────────────────────────────────
test("phoneCallErrorMessage prefers the server message, else falls back per status", () => {
  // prefers server copy
  assert.equal(
    phoneCallErrorMessage(402, "The Business Phone add-on isn't active on your plan."),
    "The Business Phone add-on isn't active on your plan.",
  );
  // status fallbacks when no server message
  assert.match(phoneCallErrorMessage(402, null), /add-on isn't active/i); // no_entitlement
  assert.match(phoneCallErrorMessage(403, ""), /permission to place Business Phone calls/i); // staff_disabled
  assert.match(phoneCallErrorMessage(429), /Too many calls/i); // concurrency
  assert.match(phoneCallErrorMessage(503), /temporarily unavailable/i); // service_unavailable / flag off
  assert.match(phoneCallErrorMessage(409), /Check the number/i); // over_cap / setup_required
  assert.match(phoneCallErrorMessage(400), /Check the number/i); // invalid / emergency
  assert.match(phoneCallErrorMessage(500), /try again/i); // generic
});

test("success message sets the bridge expectation", () => {
  assert.match(OUTBOUND_CALL_SUCCESS_MESSAGE, /calling your phone first/i);
});
