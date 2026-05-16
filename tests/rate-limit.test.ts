import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { rateLimit } from "../lib/rate-limit";

describe("rate limit", () => {
  it("allows up to capacity then blocks", () => {
    const key = `test:${Date.now()}:${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      const r = rateLimit({ key, capacity: 3, refillTokens: 3, windowMs: 1000 });
      assert.equal(r.ok, true);
    }
    const blocked = rateLimit({ key, capacity: 3, refillTokens: 3, windowMs: 1000 });
    assert.equal(blocked.ok, false);
  });

  it("returns a positive retryAfterMs when blocked", () => {
    const key = `test:${Date.now()}:${Math.random()}`;
    rateLimit({ key, capacity: 1, refillTokens: 1, windowMs: 5000 });
    const blocked = rateLimit({ key, capacity: 1, refillTokens: 1, windowMs: 5000 });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.ok(blocked.retryAfterMs > 0);
      assert.ok(blocked.retryAfterMs <= 5000);
    }
  });

  it("isolates by key", () => {
    const a = `test:${Date.now()}:a:${Math.random()}`;
    const b = `test:${Date.now()}:b:${Math.random()}`;
    rateLimit({ key: a, capacity: 1, refillTokens: 1, windowMs: 1000 });
    const ablock = rateLimit({ key: a, capacity: 1, refillTokens: 1, windowMs: 1000 });
    const bok = rateLimit({ key: b, capacity: 1, refillTokens: 1, windowMs: 1000 });
    assert.equal(ablock.ok, false);
    assert.equal(bok.ok, true);
  });
});
