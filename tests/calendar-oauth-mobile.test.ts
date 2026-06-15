/**
 * Security regression coverage for the mobile calendar-OAuth signed-state
 * handoff (lib/calendar/oauth-mobile.ts).
 *
 * The state token is the ONLY thing binding a (cookieless) provider
 * callback to the connecting user/tenant, so its integrity is critical:
 *   • a valid token round-trips to the exact user/tenant,
 *   • a token minted for one provider must NOT validate for another
 *     (prevents cross-provider replay),
 *   • tampered / foreign / empty tokens are rejected (never throw),
 *   • deep links carry NO tokens — only success/error signals.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCalendarMobileErrorUrl,
  buildCalendarMobileSuccessUrl,
  mintCalendarMobileState,
  verifyCalendarMobileState,
} from "../lib/calendar/oauth-mobile";

const USER = "user-123";
const TENANT = "tenant-abc";

test("valid state round-trips to the bound user + tenant", async () => {
  const state = await mintCalendarMobileState({ userId: USER, tenantId: TENANT, provider: "google" });
  const ok = await verifyCalendarMobileState(state, "google");
  assert.deepEqual(ok, { userId: USER, tenantId: TENANT });
});

test("a google state does NOT verify as microsoft (no cross-provider replay)", async () => {
  const state = await mintCalendarMobileState({ userId: USER, tenantId: TENANT, provider: "google" });
  assert.equal(await verifyCalendarMobileState(state, "microsoft"), null);
});

test("a tampered token is rejected", async () => {
  const state = await mintCalendarMobileState({ userId: USER, tenantId: TENANT, provider: "google" });
  const tampered = state.slice(0, -3) + (state.endsWith("a") ? "bbb" : "aaa");
  assert.equal(await verifyCalendarMobileState(tampered, "google"), null);
});

test("garbage / empty / nullish states are rejected without throwing", async () => {
  assert.equal(await verifyCalendarMobileState("not.a.jwt", "google"), null);
  assert.equal(await verifyCalendarMobileState("", "google"), null);
  assert.equal(await verifyCalendarMobileState(null, "google"), null);
  assert.equal(await verifyCalendarMobileState(undefined, "microsoft"), null);
});

test("a foreign HS256 JWT (wrong secret) is rejected", async () => {
  const { SignJWT } = await import("jose");
  const foreign = await new SignJWT({ tenantId: TENANT, provider: "google", purpose: "cal_mobile_connect" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(USER)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode("a-totally-different-secret-value-x"));
  assert.equal(await verifyCalendarMobileState(foreign, "google"), null);
});

test("deep links carry a success/error signal but NO tokens", () => {
  assert.equal(buildCalendarMobileSuccessUrl("google"), "zentromeet://oauth/calendar/google/success");
  assert.equal(buildCalendarMobileSuccessUrl("microsoft"), "zentromeet://oauth/calendar/microsoft/success");
  const err = buildCalendarMobileErrorUrl("google", "access_denied");
  assert.equal(err, "zentromeet://oauth/calendar/google/error?error=access_denied");
  // No token-like material in either URL.
  assert.ok(!/token|secret|refresh|access_token/i.test(buildCalendarMobileSuccessUrl("google")));
});
