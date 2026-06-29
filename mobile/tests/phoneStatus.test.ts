/**
 * Mobile Business Phone state-machine (M2). Pure-logic only — no React, no API,
 * no secrets. Proves the safe status DTO maps to the right Phone screen state
 * and that mobile never surfaces a purchase path beyond the web CTA, and that
 * Softphone only appears when active AND the backend flag allows it.
 *
 * Run: `npx tsx --test tests/phoneStatus.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolvePhoneScreenState,
  shouldShowSoftphone,
  shouldShowPhoneEntry,
  webCtaLabel,
  BUSINESS_PHONE_MARKETING,
  type MobilePhoneStatus,
} from "../src/lib/businessPhone";

const WEB = "https://app.zentromeet.com/dashboard/billing";

function status(over: Partial<MobilePhoneStatus> = {}): MobilePhoneStatus {
  return {
    basePlan: "pro",
    basePaid: true,
    businessPhoneAddonSubscribed: true,
    businessPhoneActive: true,
    setupState: "active",
    businessNumber: "+14155550123",
    forwardingNumber: "••• ••• 0123",
    includedMinutes: 200,
    minutesUsed: 10,
    minutesRemaining: 190,
    capReached: false,
    canClickToCall: true,
    hasPhoneAccess: true,
    canPlaceCalls: true,
    softphoneAvailable: false,
    webBillingUrl: WEB,
    ...over,
  };
}

// ── screen-state mapping ────────────────────────────────────────────
test("free / no paid base → marketing with 'Set up on web' CTA", () => {
  const s = resolvePhoneScreenState(
    status({ setupState: "no_addon", basePaid: false, businessPhoneActive: false, businessPhoneAddonSubscribed: false }),
  );
  assert.deepEqual(s, { kind: "marketing", cta: "setup_web", webBillingUrl: WEB });
  assert.equal(webCtaLabel("setup_web"), "Set up on web");
});

test("paid base, no add-on → marketing with 'Add Business Phone on web' CTA", () => {
  const s = resolvePhoneScreenState(
    status({ setupState: "no_addon", basePaid: true, businessPhoneActive: false, businessPhoneAddonSubscribed: false }),
  );
  assert.deepEqual(s, { kind: "marketing", cta: "add_web", webBillingUrl: WEB });
  assert.equal(webCtaLabel("add_web"), "Add Business Phone on web");
});

test("add-on active but setup pending → setup_pending, no controls", () => {
  assert.deepEqual(
    resolvePhoneScreenState(status({ setupState: "setup_pending", businessPhoneActive: false, canClickToCall: false })),
    { kind: "setup_pending" },
  );
});

test("active + number assigned → active, click-to-call enabled", () => {
  assert.deepEqual(resolvePhoneScreenState(status()), { kind: "active", canClickToCall: true });
  // active but this user can't place calls
  assert.deepEqual(
    resolvePhoneScreenState(status({ canClickToCall: false })),
    { kind: "active", canClickToCall: false },
  );
});

test("cap reached → cap_reached (outbound blocked)", () => {
  assert.deepEqual(
    resolvePhoneScreenState(status({ setupState: "cap_reached", capReached: true, canClickToCall: false })),
    { kind: "cap_reached" },
  );
});

test("disabled / suspended → locked", () => {
  assert.deepEqual(resolvePhoneScreenState(status({ setupState: "disabled" })), { kind: "locked", reason: "disabled" });
  assert.deepEqual(resolvePhoneScreenState(status({ setupState: "suspended" })), { kind: "locked", reason: "suspended" });
});

// ── softphone gating ────────────────────────────────────────────────
test("Softphone appears ONLY when active AND softphoneAvailable", () => {
  assert.equal(shouldShowSoftphone(status({ softphoneAvailable: false })), false); // default off
  assert.equal(shouldShowSoftphone(status({ businessPhoneActive: true, softphoneAvailable: true })), true);
  // flag on but line not active → still hidden
  assert.equal(shouldShowSoftphone(status({ businessPhoneActive: false, softphoneAvailable: true })), false);
});

// ── entry visibility + marketing copy ───────────────────────────────
test("Phone entry is shown to all signed-in users", () => {
  assert.equal(shouldShowPhoneEntry(), true);
});

test("marketing copy is honest: 500 min, softphone coming soon, no emergency/intl, web-only purchase", () => {
  const blob = JSON.stringify(BUSINESS_PHONE_MARKETING).toLowerCase();
  assert.match(blob, /500 us & canada minutes/);
  assert.match(blob, /softphone — coming soon|softphone .* coming soon/);
  assert.match(blob, /no emergency/);
  assert.match(blob, /no international/);
  assert.match(blob, /web app/); // purchase only on web
  assert.doesNotMatch(blob, /softphone (now|available|live|included)/);
});
