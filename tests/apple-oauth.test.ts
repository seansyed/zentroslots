/**
 * Sign in with Apple — backend contract (App Store Guideline 4.8).
 *
 * Source-contract tests over the native verification route: the iOS app
 * POSTs Apple's identity token; the route MUST verify it against Apple's
 * JWKS (issuer + audience pinned), reuse the shared find-or-create + mint
 * helpers, and never touch tracking. Guards the wiring so a refactor
 * can't silently weaken the verification.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const routeSrc = readFileSync(
  join(process.cwd(), "app", "api", "auth", "oauth", "apple", "native", "route.ts"),
  "utf8",
);
const oauthLibSrc = readFileSync(join(process.cwd(), "lib", "auth", "oauth.ts"), "utf8");

test("apple native route verifies against Apple's JWKS with pinned issuer + audience", () => {
  assert.ok(routeSrc.includes("createRemoteJWKSet"), "uses jose remote JWKS");
  assert.ok(routeSrc.includes("https://appleid.apple.com/auth/keys"), "Apple JWKS URL");
  assert.ok(routeSrc.includes('"https://appleid.apple.com"'), "issuer pinned");
  assert.ok(routeSrc.includes('"com.zentromeet.app"'), "audience pinned to the iOS bundle id");
  assert.ok(routeSrc.includes("jwtVerify("), "signature actually verified");
});

test("apple native route reuses the shared user + session helpers", () => {
  assert.ok(routeSrc.includes("findOrCreateUserForOAuth"), "same account linking as Google/Microsoft");
  assert.ok(routeSrc.includes("mintMobileOAuthToken"), "same mobile bearer token mint");
  assert.ok(routeSrc.includes('provider: "apple"'), "audit trail tagged apple");
});

test("apple native route rejects a missing email and an explicitly-unverified one", () => {
  assert.ok(routeSrc.includes("didn't share an email"), "missing email → 400");
  assert.ok(routeSrc.includes('email_verified === false || claims.email_verified === "false"'),
    "explicit unverified → rejected (absence tolerated; private relay is always verified)");
});

test('OAuthProvider union includes "apple"', () => {
  assert.match(oauthLibSrc, /OAuthProvider = "google" \| "microsoft" \| "apple"/);
});
