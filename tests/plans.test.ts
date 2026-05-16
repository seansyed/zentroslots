import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getPlan, isUnlimited, PLANS, formatPrice } from "../lib/plans";

describe("plans catalog", () => {
  it("has all four tiers", () => {
    assert.deepEqual(
      Object.keys(PLANS).sort(),
      ["enterprise", "free", "pro", "team"].sort()
    );
  });

  it("free has the most restrictive limits", () => {
    const free = getPlan("free");
    assert.equal(free.limits.maxStaff, 1);
    assert.equal(free.limits.maxBookingsPerMonth, 50);
    assert.equal(free.limits.customBranding, false);
    assert.equal(free.limits.analytics, false);
  });

  it("team is unlimited", () => {
    const team = getPlan("team");
    assert.ok(isUnlimited(team.limits.maxStaff));
    assert.ok(isUnlimited(team.limits.maxBookingsPerMonth));
  });

  it("unknown plan falls back to free", () => {
    assert.equal(getPlan("nonexistent").id, "free");
    assert.equal(getPlan(null).id, "free");
    assert.equal(getPlan(undefined).id, "free");
  });

  it("formatPrice handles Free and Custom", () => {
    assert.equal(formatPrice(PLANS.free), "Free");
    assert.equal(formatPrice(PLANS.enterprise), "Custom");
    assert.match(formatPrice(PLANS.pro), /^\$\d+\/mo$/);
  });
});
