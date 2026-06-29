/**
 * Business Line settings shaping/validation helpers (increment 3). Pure tests:
 * entitlement (default locked), forwarding-update validation (valid US/CA,
 * international/invalid/emergency/loop rejected), usage summary formatting, and
 * the full GET view shaping. No DB / network / React.
 *
 * Run: `npx tsx --test tests/business-line-view.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateForwardingUpdate,
  forwardingErrorMessage,
  summarizeMonthlyUsage,
  periodForDate,
  shapeBusinessLineView,
} from "../lib/business-line-view";

// Entitlement tests now live in tests/business-line-entitlement.test.ts (the
// real two-gate add-on model). This file covers validation/usage/shaping.

// ── forwarding-update validation ───────────────────────────────────
test("PATCH validation accepts a valid US/Canada forwarding number (normalized)", () => {
  assert.deepEqual(validateForwardingUpdate({ forwardingNumber: "(415) 555-2671", ownedNumbers: [] }), {
    ok: true,
    e164: "+14155552671",
  });
  assert.deepEqual(validateForwardingUpdate({ forwardingNumber: "+1 647 555 0123", ownedNumbers: [] }), {
    ok: true,
    e164: "+16475550123",
  });
});

test("PATCH validation rejects international + malformed numbers", () => {
  assert.deepEqual(validateForwardingUpdate({ forwardingNumber: "+447911123456", ownedNumbers: [] }), {
    ok: false,
    reason: "not_us_canada",
  });
  assert.deepEqual(validateForwardingUpdate({ forwardingNumber: "+1234", ownedNumbers: [] }), {
    ok: false,
    reason: "invalid",
  });
  assert.deepEqual(validateForwardingUpdate({ forwardingNumber: "", ownedNumbers: [] }), {
    ok: false,
    reason: "empty",
  });
});

test("PATCH validation rejects emergency / N11 numbers", () => {
  for (const code of ["911", "+1 911", "611"]) {
    assert.deepEqual(validateForwardingUpdate({ forwardingNumber: code, ownedNumbers: [] }), {
      ok: false,
      reason: "emergency",
    });
  }
});

test("PATCH validation rejects a forwarding loop (own business number)", () => {
  const owned = ["+14155550100"];
  assert.deepEqual(validateForwardingUpdate({ forwardingNumber: "(415) 555-0100", ownedNumbers: owned }), {
    ok: false,
    reason: "loop",
  });
  // a different valid number is fine
  assert.equal(validateForwardingUpdate({ forwardingNumber: "+14155559999", ownedNumbers: owned }).ok, true);
});

test("forwardingErrorMessage maps every reason to a friendly string", () => {
  for (const reason of ["empty", "emergency", "not_us_canada", "invalid", "loop"] as const) {
    const msg = forwardingErrorMessage(reason);
    assert.equal(typeof msg, "string");
    assert.ok(msg.length > 0);
  }
});

// ── usage summary ──────────────────────────────────────────────────
test("summarizeMonthlyUsage rounds minutes, clamps percent, flags over-cap", () => {
  const u = summarizeMonthlyUsage({
    period: "2026-06",
    usage: { billableSeconds: 90, inboundCalls: 3, answeredCalls: 2, missedCalls: 1, estimatedCostCents: 5 },
    includedMinutes: 200,
    cap: 200,
  });
  assert.equal(u.minutesUsed, 2); // 90s → ceil = 2 min
  assert.equal(u.percentUsed, 1); // 2/200 → 1%
  assert.equal(u.missedCalls, 1);
  assert.equal(u.overCap, false);

  const over = summarizeMonthlyUsage({
    period: "2026-06",
    usage: { billableSeconds: 20000 },
    includedMinutes: 200,
    cap: 200,
  });
  assert.equal(over.overCap, true);
  assert.equal(over.percentUsed, 100); // clamped

  const empty = summarizeMonthlyUsage({ period: "2026-06", usage: null, includedMinutes: 200, cap: 200 });
  assert.equal(empty.minutesUsed, 0);
  assert.equal(empty.percentUsed, 0);
  assert.equal(empty.overCap, false);
});

test("periodForDate formats YYYY-MM in UTC", () => {
  assert.equal(periodForDate(new Date("2026-06-26T17:00:00Z")), "2026-06");
  assert.equal(periodForDate(new Date("2026-01-01T00:00:00Z")), "2026-01");
});

// ── full view shaping ──────────────────────────────────────────────
test("shapeBusinessLineView: defaults are safe + locked when no rows exist", () => {
  const v = shapeBusinessLineView({ period: "2026-06", planEligible: false });
  assert.equal(v.number, null);
  assert.equal(v.entitlement.locked, true);
  assert.equal(v.entitlement.reason, "plan_not_eligible");
  assert.equal(v.settings.enabled, false);
  assert.equal(v.settings.forwardingNumber, null);
  assert.equal(v.settings.includedMinutes, 1000); // package default
  assert.equal(v.recentCalls.length, 0);
  assert.equal(v.usage.minutesUsed, 0);
});

test("shapeBusinessLineView: surfaces number, settings, entitlement, and missed flag", () => {
  const v = shapeBusinessLineView({
    period: "2026-06",
    planEligible: true,
    number: { phoneNumber: "+14155550100", status: "active", provisionedAt: new Date("2026-06-01T00:00:00Z") },
    settings: {
      enabled: true,
      forwardingNumber: "+16475550123",
      includedMinutes: 200,
      monthlyMinuteCap: 200,
      metadata: { entitlementActive: true },
    },
    usage: { billableSeconds: 120, missedCalls: 2 },
    recentCalls: [
      { id: "c1", direction: "inbound", fromNumber: "+19998887777", status: "missed", startedAt: new Date("2026-06-26T12:00:00Z"), durationSeconds: null },
      { id: "c2", direction: "inbound", fromNumber: "+15551112222", status: "completed", startedAt: "2026-06-26T13:00:00Z", durationSeconds: 75 },
    ],
  });
  assert.equal(v.number?.phoneNumber, "+14155550100");
  assert.equal(v.number?.provisionedAt, "2026-06-01T00:00:00.000Z");
  assert.equal(v.entitlement.active, true);
  assert.equal(v.settings.forwardingNumber, "+16475550123");
  assert.equal(v.usage.minutesUsed, 2);
  assert.equal(v.recentCalls[0].missed, true);
  assert.equal(v.recentCalls[1].missed, false);
  assert.equal(v.recentCalls[1].startedAt, "2026-06-26T13:00:00Z");
});
