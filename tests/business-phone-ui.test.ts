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
  canManageStaffAccess,
  staffPhoneNumberLabel,
  staffAccessStatusLabel,
  STAFF_PHONE_PRIVACY_NOTE,
  BUSINESS_PHONE_TABS,
  businessPhoneTabLabel,
  CLICK_TO_CALL_EXPLAINER,
  SOFTPHONE_COMING_COPY,
  BUSINESS_PHONE_HERO,
  BUSINESS_PHONE_FEATURES,
  BUSINESS_PHONE_EMERGENCY_NOTICE,
  BUSINESS_PHONE_USAGE_RESET_NOTE,
  BUSINESS_PHONE_NO_OVERAGE_NOTE,
  BUSINESS_PHONE_CALLS_EMPTY,
  webPhoneStatusBadge,
  resolveWebPhoneView,
  resolveAddonCardAction,
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

// ── staff access admin (P1.2.2) ────────────────────────────────────
test("staff access admin section is operator-only", () => {
  assert.equal(canManageStaffAccess("admin"), true);
  assert.equal(canManageStaffAccess("manager"), true);
  assert.equal(canManageStaffAccess("staff"), false);
  assert.equal(canManageStaffAccess("client"), false);
});

test("staff number label is masked-or-'Not set' — never a full number", () => {
  assert.equal(staffPhoneNumberLabel({ configured: true, masked: "••• ••• 0182" }), "••• ••• 0182");
  assert.equal(staffPhoneNumberLabel({ configured: false, masked: null }), "Not set");
  // even if a configured flag is set without a masked value, no raw number is shown
  assert.equal(staffPhoneNumberLabel({ configured: true, masked: null }), "Not set");
});

test("staff access status label reflects enabled / can-place state", () => {
  assert.equal(staffAccessStatusLabel({ enabled: false, canPlaceCalls: false }), "Disabled");
  assert.equal(staffAccessStatusLabel({ enabled: false, canPlaceCalls: true }), "Disabled");
  assert.equal(staffAccessStatusLabel({ enabled: true, canPlaceCalls: false }), "Cannot place calls");
  assert.equal(staffAccessStatusLabel({ enabled: true, canPlaceCalls: true }), "Active");
});

test("customer caller-ID copy is correct (staff privacy note)", () => {
  assert.match(STAFF_PHONE_PRIVACY_NOTE, /Customers see your ZentroMeet business number/);
  assert.match(STAFF_PHONE_PRIVACY_NOTE, /only to connect staff to outbound Business Phone calls/);
});

// ── honest relabel / tabs (P1.2.A) ─────────────────────────────────
test("Business Phone tabs are forwarding / click-to-call / softphone", () => {
  assert.deepEqual([...BUSINESS_PHONE_TABS], ["forwarding", "click_to_call", "softphone"]);
  assert.equal(businessPhoneTabLabel("forwarding"), "Forwarding");
  assert.equal(businessPhoneTabLabel("click_to_call"), "Click-to-Call");
  assert.equal(businessPhoneTabLabel("softphone"), "Softphone");
});

test("click-to-call copy makes clear it is NOT in-browser talking (not a softphone)", () => {
  assert.match(CLICK_TO_CALL_EXPLAINER, /calls your phone first/i);
  assert.match(CLICK_TO_CALL_EXPLAINER, /not in the browser/i);
  // never call the Phase 1 feature a softphone
  assert.doesNotMatch(CLICK_TO_CALL_EXPLAINER, /softphone/i);
});

test("softphone placeholder copy says coming/not available — no false claim", () => {
  assert.match(SOFTPHONE_COMING_COPY, /Phase 2/);
  assert.match(SOFTPHONE_COMING_COPY, /not available yet/i);
});

// ── launch page copy ($29 / 1,000 single plan) ─────────────────────
test("hero copy is the $29 / 1,000-minute Business Phone launch plan", () => {
  assert.equal(BUSINESS_PHONE_HERO.title, "Business Phone");
  assert.equal(BUSINESS_PHONE_HERO.price, "$29/month");
  assert.match(BUSINESS_PHONE_HERO.minutes, /1,000 US & Canada minutes/);
  assert.match(BUSINESS_PHONE_HERO.subtitle, /dedicated business number/i);
  // no stale price/minutes/naming anywhere in the hero
  const blob = JSON.stringify(BUSINESS_PHONE_HERO).toLowerCase();
  assert.doesNotMatch(blob, /\$19|19\/month|200 us|200 minutes|business line/);
});

test("feature bullets use the launch copy, not Business Line", () => {
  const blob = JSON.stringify(BUSINESS_PHONE_FEATURES).toLowerCase();
  assert.match(blob, /dedicated business number/);
  assert.match(blob, /click-to-call from zentromeet/);
  assert.match(blob, /softphone — coming soon|softphone .* coming soon/);
  assert.doesNotMatch(blob, /business line|\$19|200 minutes/);
});

test("emergency notice is honest — not 'inbound only' (click-to-call exists)", () => {
  assert.match(BUSINESS_PHONE_EMERGENCY_NOTICE, /not an emergency calling service/i);
  assert.match(BUSINESS_PHONE_EMERGENCY_NOTICE, /911/);
  assert.match(BUSINESS_PHONE_EMERGENCY_NOTICE, /location services are not supported/i);
  assert.doesNotMatch(BUSINESS_PHONE_EMERGENCY_NOTICE, /inbound (calls )?only/i);
  assert.doesNotMatch(BUSINESS_PHONE_EMERGENCY_NOTICE.toLowerCase(), /business line/);
});

test("usage + recent-calls helper copy", () => {
  assert.match(BUSINESS_PHONE_USAGE_RESET_NOTE, /reset each billing period/i);
  assert.match(BUSINESS_PHONE_NO_OVERAGE_NOTE, /no surprise overage/i);
  assert.equal(BUSINESS_PHONE_CALLS_EMPTY.title, "No calls yet");
  assert.match(BUSINESS_PHONE_CALLS_EMPTY.body, /after your first Business Phone call/i);
});

// ── hero status badge ──────────────────────────────────────────────
test("webPhoneStatusBadge maps every setup state to a label + tone", () => {
  assert.deepEqual(webPhoneStatusBadge("no_addon"), { label: "Not active", tone: "neutral" });
  assert.deepEqual(webPhoneStatusBadge("setup_pending"), { label: "Setup pending", tone: "amber" });
  assert.deepEqual(webPhoneStatusBadge("active"), { label: "Active", tone: "green" });
  assert.deepEqual(webPhoneStatusBadge("cap_reached"), { label: "Cap reached", tone: "amber" });
  assert.deepEqual(webPhoneStatusBadge("disabled"), { label: "Disabled", tone: "neutral" });
  assert.deepEqual(webPhoneStatusBadge("suspended"), { label: "Suspended", tone: "red" });
});

// ── page view state machine ────────────────────────────────────────
test("resolveWebPhoneView: only active/cap_reached expose working controls", () => {
  assert.deepEqual(resolveWebPhoneView({ setupState: "no_addon" }), { kind: "marketing", showActiveControls: false });
  assert.deepEqual(resolveWebPhoneView({ setupState: "setup_pending" }), { kind: "setup_pending", showActiveControls: false });
  assert.deepEqual(resolveWebPhoneView({ setupState: "disabled" }), { kind: "disabled", showActiveControls: false });
  assert.deepEqual(resolveWebPhoneView({ setupState: "suspended" }), { kind: "suspended", showActiveControls: false });
  assert.deepEqual(resolveWebPhoneView({ setupState: "active" }), { kind: "active", showActiveControls: true });
  assert.deepEqual(resolveWebPhoneView({ setupState: "cap_reached" }), { kind: "active", showActiveControls: true });
});

test("setup-pending hides active controls; active shows them", () => {
  assert.equal(resolveWebPhoneView({ setupState: "setup_pending" }).showActiveControls, false);
  assert.equal(resolveWebPhoneView({ setupState: "active" }).showActiveControls, true);
});

// ── add-on card action (internal Enterprise never sees 'subscribe to base') ──
test("resolveAddonCardAction: internal Enterprise → internal (no Stripe / no base-plan prompt)", () => {
  // internal wins even with no base subscription — never "need_base"
  assert.equal(
    resolveAddonCardAction({ internalAccount: true, suspended: false, addonSubscribed: false, baseSubscriptionActive: false }),
    "internal",
  );
});

test("resolveAddonCardAction: suspended / remove / add / need_base", () => {
  assert.equal(
    resolveAddonCardAction({ internalAccount: false, suspended: true, addonSubscribed: true, baseSubscriptionActive: true }),
    "suspended",
  );
  assert.equal(
    resolveAddonCardAction({ internalAccount: false, suspended: false, addonSubscribed: true, baseSubscriptionActive: true }),
    "remove",
  );
  assert.equal(
    resolveAddonCardAction({ internalAccount: false, suspended: false, addonSubscribed: false, baseSubscriptionActive: true }),
    "add",
  );
  assert.equal(
    resolveAddonCardAction({ internalAccount: false, suspended: false, addonSubscribed: false, baseSubscriptionActive: false }),
    "need_base",
  );
});
