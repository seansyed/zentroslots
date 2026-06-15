import { test } from "node:test";
import assert from "node:assert/strict";

import { absolutizeUrl } from "../src/lib/url";

const BASE = "https://app.zentromeet.com";

// Regression coverage for the "profile image not showing" bug: the backend
// returns RELATIVE avatar/logo paths that RN <Image> cannot load.

test("absolutizes a relative path against the API origin", () => {
  assert.equal(
    absolutizeUrl("/uploads/avatars/abc.png", BASE),
    "https://app.zentromeet.com/uploads/avatars/abc.png",
  );
});

test("adds a leading slash when the relative path lacks one", () => {
  assert.equal(
    absolutizeUrl("uploads/x.png", BASE),
    "https://app.zentromeet.com/uploads/x.png",
  );
});

test("leaves absolute http/https URLs untouched", () => {
  const abs = "https://lh3.googleusercontent.com/a/abc=s96";
  assert.equal(absolutizeUrl(abs, BASE), abs);
  assert.equal(absolutizeUrl("http://x.test/y.png", BASE), "http://x.test/y.png");
});

test("leaves protocol-relative and data URLs untouched", () => {
  assert.equal(absolutizeUrl("//cdn.test/a.png", BASE), "//cdn.test/a.png");
  assert.equal(absolutizeUrl("data:image/png;base64,AAAA", BASE), "data:image/png;base64,AAAA");
});

test("returns null for empty / nullish input (initials fallback)", () => {
  assert.equal(absolutizeUrl(null, BASE), null);
  assert.equal(absolutizeUrl(undefined, BASE), null);
  assert.equal(absolutizeUrl("", BASE), null);
  assert.equal(absolutizeUrl("   ", BASE), null);
});

test("tolerates a trailing slash on the base origin", () => {
  assert.equal(
    absolutizeUrl("/uploads/x.png", "https://app.zentromeet.com/"),
    "https://app.zentromeet.com/uploads/x.png",
  );
});
