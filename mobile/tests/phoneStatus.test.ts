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
  BUSINESS_PHONE_UPGRADE_NOTICE,
  BUSINESS_PHONE_INTERNAL_NOTICE,
  type MobilePhoneStatus,
} from "../src/lib/businessPhone";

const WEB = "https://app.zentromeet.com/dashboard/billing";

function status(over: Partial<MobilePhoneStatus> = {}): MobilePhoneStatus {
  return {
    basePlan: "pro",
    basePaid: true,
    internalAccount: false,
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
test("free / ineligible base → marketing with 'upgrade_required' (View plans, no purchase)", () => {
  const s = resolvePhoneScreenState(
    status({ setupState: "no_addon", basePaid: false, internalAccount: false, businessPhoneActive: false, businessPhoneAddonSubscribed: false }),
  );
  assert.deepEqual(s, { kind: "marketing", cta: "upgrade_required", webBillingUrl: WEB });
  assert.equal(webCtaLabel("upgrade_required"), "View plans");
});

test("paid base, no add-on → marketing with 'Add Business Phone on web' CTA", () => {
  const s = resolvePhoneScreenState(
    status({ setupState: "no_addon", basePaid: true, internalAccount: false, businessPhoneActive: false, businessPhoneAddonSubscribed: false }),
  );
  assert.deepEqual(s, { kind: "marketing", cta: "add_web", webBillingUrl: WEB });
  assert.equal(webCtaLabel("add_web"), "Add Business Phone on web");
});

test("internal Enterprise → marketing 'internal' (manual super-admin; no purchase button, never upgrade_required)", () => {
  // internalAccount wins even though basePaid is true for an internal tenant
  const s = resolvePhoneScreenState(
    status({ setupState: "no_addon", internalAccount: true, basePaid: true, businessPhoneActive: false, businessPhoneAddonSubscribed: false }),
  );
  assert.deepEqual(s, { kind: "marketing", cta: "internal", webBillingUrl: WEB });
  assert.equal(webCtaLabel("internal"), ""); // no button
});

test("internal flag absent (older backend) falls back gracefully — not 'internal'", () => {
  const s = resolvePhoneScreenState(
    status({ setupState: "no_addon", internalAccount: undefined, basePaid: false, businessPhoneActive: false, businessPhoneAddonSubscribed: false }),
  );
  assert.equal(s.kind === "marketing" && s.cta, "upgrade_required");
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

test("marketing copy is honest: $29 / 1,000 min, softphone coming soon, no emergency/intl, web-only purchase", () => {
  const blob = JSON.stringify(BUSINESS_PHONE_MARKETING).toLowerCase();
  assert.match(blob, /\$29\/month/);
  assert.match(blob, /1,000 us & canada minutes/);
  assert.match(blob, /softphone — coming soon|softphone .* coming soon/);
  assert.match(blob, /no emergency/);
  assert.match(blob, /no international/);
  assert.match(blob, /web app/); // purchase only on web
  assert.doesNotMatch(blob, /softphone (now|available|live|included)/);
  // never the harsh web phrase anywhere in the marketing copy
  assert.doesNotMatch(blob, /subscribe to a base plan first/);
});

test("upgrade-required + internal notices: amber upgrade copy + manual super-admin; no harsh phrase", () => {
  assert.equal(BUSINESS_PHONE_UPGRADE_NOTICE.title, "Upgrade required");
  assert.match(BUSINESS_PHONE_UPGRADE_NOTICE.body, /available on Pro and higher plans/);
  assert.match(BUSINESS_PHONE_UPGRADE_NOTICE.body, /Upgrade your ZentroMeet plan first/);
  assert.match(BUSINESS_PHONE_INTERNAL_NOTICE, /Internal Enterprise account/);
  assert.match(BUSINESS_PHONE_INTERNAL_NOTICE, /enabled manually by a super admin/i);
  const blob = (JSON.stringify(BUSINESS_PHONE_UPGRADE_NOTICE) + " " + BUSINESS_PHONE_INTERNAL_NOTICE).toLowerCase();
  assert.doesNotMatch(blob, /subscribe to a base plan first/);
});
