import { test } from "node:test";
import assert from "node:assert/strict";

import { hasSlug, serviceBookingUrl, tenantBookingUrl } from "../src/lib/bookingLinks";

const BASE = "https://app.zentromeet.com";

test("tenant booking URL is {base}/u/{slug}", () => {
  assert.equal(tenantBookingUrl(BASE, "acme"), "https://app.zentromeet.com/u/acme");
});

test("service booking URL is {base}/u/{tenantSlug}/{serviceSlug}", () => {
  assert.equal(
    serviceBookingUrl(BASE, "acme", "tax-return"),
    "https://app.zentromeet.com/u/acme/tax-return",
  );
});

test("trailing slashes on the base are normalized (no //u)", () => {
  assert.equal(tenantBookingUrl("https://app.zentromeet.com/", "acme"), "https://app.zentromeet.com/u/acme");
  assert.equal(
    serviceBookingUrl("https://app.zentromeet.com///", "acme", "x"),
    "https://app.zentromeet.com/u/acme/x",
  );
});

test("links carry NO internal IDs, tokens, or ?staff param", () => {
  const url = serviceBookingUrl(BASE, "acme", "consult");
  assert.ok(!url.includes("?"), "no query string");
  assert.ok(!/staff/i.test(url), "no staff param");
  // exactly: /u/<tenant>/<service>
  const path = url.replace(BASE, "");
  assert.equal(path, "/u/acme/consult");
});

test("slug segments are URL-encoded defensively", () => {
  assert.equal(tenantBookingUrl(BASE, "a b"), "https://app.zentromeet.com/u/a%20b");
});

test("hasSlug guards empty / whitespace / null", () => {
  assert.equal(hasSlug("acme"), true);
  assert.equal(hasSlug(""), false);
  assert.equal(hasSlug("   "), false);
  assert.equal(hasSlug(null), false);
  assert.equal(hasSlug(undefined), false);
});
