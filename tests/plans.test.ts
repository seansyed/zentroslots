import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getPlan, isUnlimited, PLANS, formatPrice } from "../lib/plans";

// Phase 16A moved the catalog from 4 tiers to 5 (added "solo"), made
// Enterprise self-serve at a concrete price, gave Free unlimited bookings
// (capped instead on staff + active services), and capped Team staff at 10.
// These expectations track that intended catalog so the limits stay
// guarded against accidental regressions.
describe("plans catalog", () => {
  it("has all five tiers", () => {
    assert.deepEqual(
      Object.keys(PLANS).sort(),
      ["enterprise", "free", "pro", "solo", "team"].sort()
    );
  });

  it("free is the most restrictive paid-feature tier", () => {
    const free = getPlan("free");
    assert.equal(free.limits.maxStaff, 1);
    // Free monetizes on staff + active services, not booking volume.
    assert.ok(isUnlimited(free.limits.maxBookingsPerMonth));
    assert.equal(free.limits.maxActiveServices, 3);
    assert.equal(free.limits.customBranding, false);
    assert.equal(free.limits.analytics, false);
  });

  it("team allows 10 staff and unlimited bookings", () => {
    const team = getPlan("team");
    assert.equal(team.limits.maxStaff, 10);
    assert.ok(isUnlimited(team.limits.maxBookingsPerMonth));
  });

  it("enterprise is unlimited staff", () => {
    const ent = getPlan("enterprise");
    assert.ok(isUnlimited(ent.limits.maxStaff));
    assert.ok(isUnlimited(ent.limits.maxManagers));
  });

  it("unknown plan falls back to free", () => {
    assert.equal(getPlan("nonexistent").id, "free");
    assert.equal(getPlan(null).id, "free");
    assert.equal(getPlan(undefined).id, "free");
  });

  it("formatPrice renders Free and concrete paid prices", () => {
    assert.equal(formatPrice(PLANS.free), "Free");
    // Enterprise became self-serve at a real price (no longer "Custom").
    assert.equal(formatPrice(PLANS.enterprise), "$250/mo");
    assert.match(formatPrice(PLANS.pro), /^\$\d+\/mo$/);
    assert.match(formatPrice(PLANS.solo), /^\$\d+\/mo$/);
  });
});
