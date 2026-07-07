/**
 * Regression guards for the App Store rejection fixes (2026-06-30):
 *
 *   • Guideline 4.8  — Sign in with Apple is offered on iOS alongside the
 *                      third-party providers (native flow, official button).
 *   • Guideline 3.1.1 — iOS shows NO pricing and NO external purchase /
 *                      upgrade CTAs (Business Phone marketing + Settings
 *                      billing handoff). Android keeps the full purchase UI.
 *
 * Pure-logic tests run the platform gate directly; source-contract tests
 * pin the screen wiring so a refactor can't silently reintroduce a
 * rejected surface. Paths resolve from the mobile package root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canShowPurchaseUi,
  BUSINESS_PHONE_IOS_UNAVAILABLE_NOTICE,
} from "../src/lib/businessPhone";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

// ── 3.1.1 pure gate ──────────────────────────────────────────────────────────

test("canShowPurchaseUi: hidden on iOS, shown elsewhere", () => {
  assert.equal(canShowPurchaseUi("ios"), false);
  assert.equal(canShowPurchaseUi("android"), true);
  assert.equal(canShowPurchaseUi("web"), true);
});

test("iOS unavailable notice has no price and no purchase direction", () => {
  const s = BUSINESS_PHONE_IOS_UNAVAILABLE_NOTICE.toLowerCase();
  for (const banned of ["$", "upgrade", "billing", "subscribe", "purchase", "buy", "plan"]) {
    assert.ok(!s.includes(banned), `notice must not contain "${banned}"`);
  }
});

// ── 3.1.1 screen wiring ──────────────────────────────────────────────────────

test("phone.tsx gates price + purchase CTAs behind the platform gate", () => {
  const src = read("app", "(tabs)", "phone.tsx");
  assert.ok(src.includes("canShowPurchaseUi(Platform.OS)"), "must compute the platform gate");
  assert.ok(src.includes("SHOW_PURCHASE_UI ?"), "price block must be gated");
  assert.ok(
    src.includes("BUSINESS_PHONE_IOS_UNAVAILABLE_NOTICE"),
    "iOS branch must render the neutral notice",
  );
  // The internal branch must be resolved BEFORE the iOS collapse so internal
  // Enterprise tenants keep their manual-provisioning message.
  assert.ok(
    src.indexOf('screen.cta === "internal"') < src.indexOf("!SHOW_PURCHASE_UI"),
    "internal notice must take precedence over the iOS neutral notice",
  );
});

test("settings.tsx hides the Billing & plan handoff on iOS", () => {
  const src = read("app", "(tabs)", "settings.tsx");
  const billingIdx = src.indexOf('label: "Billing & plan"');
  assert.ok(billingIdx > 0, "Billing & plan row still exists (Android/web)");
  const gateIdx = src.indexOf('Platform.OS !== "ios"');
  assert.ok(gateIdx > 0 && gateIdx < billingIdx, "billing row must be spread behind a non-iOS gate");
});

// ── 4.8 Sign in with Apple ───────────────────────────────────────────────────

test("login.tsx offers the official Apple button on iOS, before Google", () => {
  const src = read("app", "login.tsx");
  assert.ok(src.includes("AppleAuthentication.AppleAuthenticationButton"), "official HIG button");
  assert.ok(src.includes('Platform.OS === "ios"'), "Apple button is iOS-gated");
  assert.ok(
    src.indexOf("AppleAuthenticationButton") < src.indexOf("Continue with Google"),
    "Apple option renders above the third-party providers",
  );
});

test("useAuth signs in with Apple natively via the backend verify endpoint", () => {
  const hook = read("src", "hooks", "useAuth.ts");
  assert.ok(hook.includes("signInWithApple"), "hook exposes signInWithApple");
  assert.ok(hook.includes("AppleAuthentication.signInAsync"), "native OS sheet, no browser leg");
  const api = read("src", "api", "auth.ts");
  assert.ok(api.includes("/api/auth/oauth/apple/native"), "posts the identity token for verification");
});

test("app.json enables the Sign in with Apple capability", () => {
  const app = JSON.parse(read("app.json")).expo;
  assert.equal(app.ios.usesAppleSignIn, true, "ios.usesAppleSignIn entitlement");
  assert.ok(app.plugins.includes("expo-apple-authentication"), "config plugin registered");
});
