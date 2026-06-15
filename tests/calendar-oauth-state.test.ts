import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generateCalendarOAuthState,
  calendarStateMatches,
  calStateCookieName,
} from "../lib/calendar/oauth-state";

// CSRF state validation for the calendar-connect OAuth flows (Google +
// Microsoft). The cookie read/write (set/consume) is server-only
// (next/headers) and exercised at the route layer; the security-critical
// matching + token generation are pure and tested here.
//
// Route-level guarantees that complement these unit tests:
//  - single-use: consumeCalendarStateCookie() deletes the cookie on read,
//    so a state cannot be replayed even if intercepted.
//  - expiry: the cookie carries maxAge=600s; after that the browser drops
//    it and the callback sees no stored value → match fails.
//  - unauthenticated initiation: /connect calls requireRole(), so an
//    unauthenticated user cannot even start the flow.
describe("calendar OAuth state", () => {
  it("generates a 32-byte (43-char base64url) token", () => {
    const s = generateCalendarOAuthState();
    assert.match(s, /^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url, no padding
  });

  it("generates a unique, unpredictable token each call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateCalendarOAuthState());
    assert.equal(seen.size, 200); // no collisions → not guessable/reusable by prediction
  });

  it("accepts an exact match (valid state)", () => {
    const s = generateCalendarOAuthState();
    assert.equal(calendarStateMatches(s, s), true);
  });

  it("rejects a missing stored state", () => {
    assert.equal(calendarStateMatches(null, "abc"), false);
    assert.equal(calendarStateMatches(undefined, "abc"), false);
    assert.equal(calendarStateMatches("", "abc"), false);
  });

  it("rejects a missing presented state", () => {
    const s = generateCalendarOAuthState();
    assert.equal(calendarStateMatches(s, null), false);
    assert.equal(calendarStateMatches(s, undefined), false);
    assert.equal(calendarStateMatches(s, ""), false);
  });

  it("rejects a mismatched state", () => {
    const a = generateCalendarOAuthState();
    const b = generateCalendarOAuthState();
    assert.equal(calendarStateMatches(a, b), false);
  });

  it("rejects a different-length / malformed state", () => {
    const s = generateCalendarOAuthState();
    assert.equal(calendarStateMatches(s, s + "x"), false);
    assert.equal(calendarStateMatches(s, s.slice(0, -1)), false);
  });

  it("is case-sensitive (no partial/loose match)", () => {
    const s = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_aaaa12";
    assert.equal(calendarStateMatches(s, s.toLowerCase()), false);
  });

  it("namespaces the cookie per provider (no cross-flow stomping)", () => {
    assert.equal(calStateCookieName("google"), "zm_cal_state_google");
    assert.equal(calStateCookieName("microsoft"), "zm_cal_state_microsoft");
    assert.notEqual(calStateCookieName("google"), calStateCookieName("microsoft"));
  });
});
