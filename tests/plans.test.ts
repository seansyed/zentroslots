import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getPlan, isUnlimited, PLANS, formatPrice, PLAN_RANK, type PlanId } from "../lib/plans";

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

// The Stripe customer.subscription.updated handler classifies a plan change
// as an upgrade vs downgrade by comparing PLAN_RANK[newPlan] to
// PLAN_RANK[oldPlan] (app/api/webhooks/stripe/route.ts). These tests guard
// that ordering + the exact comparison the handler uses, so a reorder of the
// rank table can never silently invert the owner upgrade/downgrade emails.
describe("PLAN_RANK — upgrade/downgrade ordering (owner billing emails)", () => {
  const ORDER: PlanId[] = ["free", "solo", "pro", "team", "enterprise"];

  it("is a strict ascending total order free < solo < pro < team < enterprise", () => {
    for (let i = 1; i < ORDER.length; i++) {
      assert.ok(
        PLAN_RANK[ORDER[i]] > PLAN_RANK[ORDER[i - 1]],
        `${ORDER[i]} should outrank ${ORDER[i - 1]}`,
      );
    }
  });

  // Mirrors the handler's predicate exactly: only fire when both plans
  // resolve and the rank changed; newRank > oldRank ⇒ upgrade.
  function classify(oldP: PlanId, newP: PlanId): "plan_upgrade" | "plan_downgrade" | "none" {
    const oldR = PLAN_RANK[oldP];
    const newR = PLAN_RANK[newP];
    if (newR === oldR) return "none";
    return newR > oldR ? "plan_upgrade" : "plan_downgrade";
  }

  it("classifies representative upgrades", () => {
    assert.equal(classify("free", "pro"), "plan_upgrade");
    assert.equal(classify("solo", "team"), "plan_upgrade");
    assert.equal(classify("pro", "enterprise"), "plan_upgrade");
  });

  it("classifies representative downgrades", () => {
    assert.equal(classify("enterprise", "pro"), "plan_downgrade");
    assert.equal(classify("team", "solo"), "plan_downgrade");
    assert.equal(classify("pro", "free"), "plan_downgrade");
  });

  it("treats a same-plan update as no change (no email)", () => {
    for (const p of ORDER) assert.equal(classify(p, p), "none");
  });
});
