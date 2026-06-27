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
} from "../lib/business-phone-ui";

// ── sidebar / page visibility ──────────────────────────────────────
test("Phone nav hidden unless entitled AND an operator role", () => {
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "admin" }), true);
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "manager" }), true);
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "staff" }), false);
  assert.equal(shouldShowPhoneNav({ entitled: true, role: "client" }), false);
  assert.equal(shouldShowPhoneNav({ entitled: false, role: "admin" }), false); // not subscribed
});

// ── customer call button ───────────────────────────────────────────
test("customer call button shown only when entitled AND a phone exists", () => {
  assert.equal(canShowCustomerCallButton({ entitled: true, phone: "+14155550182" }), true);
  assert.equal(canShowCustomerCallButton({ entitled: true, phone: null }), false);
  assert.equal(canShowCustomerCallButton({ entitled: true, phone: "   " }), false);
  assert.equal(canShowCustomerCallButton({ entitled: false, phone: "+14155550182" }), false);
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
  assert.match(phoneCallErrorMessage(403, ""), /allowed to place calls/i); // staff_disabled
  assert.match(phoneCallErrorMessage(429), /Too many calls/i); // concurrency
  assert.match(phoneCallErrorMessage(503), /isn't available/i); // service_unavailable / flag off
  assert.match(phoneCallErrorMessage(409), /Check the number/i); // over_cap / setup_required
  assert.match(phoneCallErrorMessage(400), /Check the number/i); // invalid / emergency
  assert.match(phoneCallErrorMessage(500), /try again/i); // generic
});

test("success message sets the bridge expectation", () => {
  assert.match(OUTBOUND_CALL_SUCCESS_MESSAGE, /calling your phone first/i);
});
