/**
 * Business Line (telephony MVP) data-foundation helpers. Pins the pure rules
 * the schema depends on: US/Canada E.164 validation, emergency rejection,
 * forwarding-loop detection, billable-minute rounding, the placeholder cost
 * estimate, and call-status normalization. No DB / Telnyx / network here.
 *
 * Run with `npx tsx --test tests/business-line.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeE164Phone,
  validateUSCanadaE164,
  isEmergencyNumber,
  isForwardingLoop,
  secondsToBillableMinutes,
  estimateForwardingCostCents,
  normalizeCallStatus,
  BUSINESS_LINE_DEFAULT_PACKAGE,
} from "../lib/business-line";

// ── normalization ──────────────────────────────────────────────────
test("normalizeE164Phone: NANP conveniences + passthrough", () => {
  assert.equal(normalizeE164Phone("(415) 555-2671"), "+14155552671"); // 10-digit → +1
  assert.equal(normalizeE164Phone("1-415-555-2671"), "+14155552671"); // 11-digit leading 1
  assert.equal(normalizeE164Phone("+1 415 555 2671"), "+14155552671"); // already +
  assert.equal(normalizeE164Phone("  +44 7911 123456 "), "+447911123456"); // intl passthrough
  assert.equal(normalizeE164Phone("no digits"), null);
  assert.equal(normalizeE164Phone(""), null);
  assert.equal(normalizeE164Phone(null), null);
});

// ── valid US/Canada numbers ────────────────────────────────────────
test("validateUSCanadaE164: accepts valid US + Canada numbers", () => {
  for (const [input, e164] of [
    ["+14155552671", "+14155552671"], // US (San Francisco)
    ["(212) 555-0182", "+12125550182"], // US, formatted
    ["+1 647 555 0123", "+16475550123"], // Canada (Toronto)
    ["4035551234", "+14035551234"], // Canada (Calgary), bare 10-digit
  ] as const) {
    const v = validateUSCanadaE164(input);
    assert.deepEqual(v, { ok: true, e164 }, `expected ${input} → ${e164}`);
  }
});

// ── invalid / international rejected ────────────────────────────────
test("validateUSCanadaE164: rejects international + malformed", () => {
  assert.deepEqual(validateUSCanadaE164("+447911123456"), { ok: false, reason: "not_us_canada" }); // UK
  assert.deepEqual(validateUSCanadaE164("+33123456789"), { ok: false, reason: "not_us_canada" }); // France
  assert.deepEqual(validateUSCanadaE164("+1234"), { ok: false, reason: "invalid" }); // +1 but too short
  assert.deepEqual(validateUSCanadaE164("+1 155 555 1234"), { ok: false, reason: "invalid" }); // area code starts with 1
  assert.deepEqual(validateUSCanadaE164(""), { ok: false, reason: "empty" });
  assert.deepEqual(validateUSCanadaE164("   "), { ok: false, reason: "empty" });
});

// ── emergency numbers rejected ─────────────────────────────────────
test("validateUSCanadaE164 / isEmergencyNumber: reject emergency + N11", () => {
  for (const code of ["911", "9-1-1", "112", "999", "+1 911", "1911", "611", "411"]) {
    assert.equal(isEmergencyNumber(code), true, `${code} should be emergency`);
    assert.deepEqual(validateUSCanadaE164(code), { ok: false, reason: "emergency" });
  }
  // A normal subscriber number that merely contains 911 is NOT emergency.
  assert.equal(isEmergencyNumber("+14155559110"), false);
  assert.deepEqual(validateUSCanadaE164("+14155559110"), { ok: true, e164: "+14155559110" });
});

// ── forwarding loop detection ──────────────────────────────────────
test("isForwardingLoop: forwarding to an owned business number is a loop", () => {
  const owned = ["+14155550100", "+16475550111"];
  assert.equal(isForwardingLoop("+14155550100", owned), true); // exact
  assert.equal(isForwardingLoop("(415) 555-0100", owned), true); // normalization-insensitive
  assert.equal(isForwardingLoop("4155550100", owned), true); // bare 10-digit
  assert.equal(isForwardingLoop("+14155559999", owned), false); // different number
  assert.equal(isForwardingLoop(null, owned), false);
  assert.equal(isForwardingLoop("+14155550100", []), false); // no owned numbers
});

// ── seconds → billable minutes ─────────────────────────────────────
test("secondsToBillableMinutes: round UP to whole minutes", () => {
  assert.equal(secondsToBillableMinutes(0), 0);
  assert.equal(secondsToBillableMinutes(null), 0);
  assert.equal(secondsToBillableMinutes(-5), 0);
  assert.equal(secondsToBillableMinutes(1), 1);
  assert.equal(secondsToBillableMinutes(60), 1);
  assert.equal(secondsToBillableMinutes(61), 2);
  assert.equal(secondsToBillableMinutes(119), 2);
  assert.equal(secondsToBillableMinutes(120), 2);
  assert.equal(secondsToBillableMinutes(600), 10);
});

// ── cost estimate (placeholder rates) ──────────────────────────────
test("estimateForwardingCostCents: placeholder 2-leg estimate, rounded up", () => {
  // default rates 0.7 + 1.0 = 1.7 cents/min
  assert.equal(estimateForwardingCostCents(0), 0);
  assert.equal(estimateForwardingCostCents(30), 2); // 1 min → ceil(1.7) = 2
  assert.equal(estimateForwardingCostCents(60), 2); // 1 min → 2
  assert.equal(estimateForwardingCostCents(600), 17); // 10 min → ceil(17) = 17
  // override rates
  assert.equal(
    estimateForwardingCostCents(120, { inboundRateCentsPerMin: 1, forwardRateCentsPerMin: 1 }),
    4, // 2 min × 2 cents
  );
});

// ── call status normalization ──────────────────────────────────────
test("normalizeCallStatus: canonical + Telnyx synonyms, unknown → null", () => {
  assert.equal(normalizeCallStatus("ringing"), "ringing");
  assert.equal(normalizeCallStatus("call.initiated"), "ringing");
  assert.equal(normalizeCallStatus("answered"), "answered");
  assert.equal(normalizeCallStatus("call.answered"), "answered");
  assert.equal(normalizeCallStatus("bridged"), "answered");
  assert.equal(normalizeCallStatus("call.hangup"), "completed");
  assert.equal(normalizeCallStatus("completed"), "completed");
  assert.equal(normalizeCallStatus("no-answer"), "missed");
  assert.equal(normalizeCallStatus("busy"), "rejected");
  assert.equal(normalizeCallStatus("no_forwarding"), "no_forwarding");
  assert.equal(normalizeCallStatus("FAILED"), "failed"); // case-insensitive
  assert.equal(normalizeCallStatus("teleported"), null); // unknown
  assert.equal(normalizeCallStatus(null), null);
});

// ── package assumption is documented in code (no billing logic) ────
test("BUSINESS_LINE_DEFAULT_PACKAGE encodes the $19 / 200-min assumption", () => {
  assert.equal(BUSINESS_LINE_DEFAULT_PACKAGE.monthlyPriceCents, 1900);
  assert.equal(BUSINESS_LINE_DEFAULT_PACKAGE.includedMinutes, 200);
  assert.equal(BUSINESS_LINE_DEFAULT_PACKAGE.hardCapMinutes, 200);
});
