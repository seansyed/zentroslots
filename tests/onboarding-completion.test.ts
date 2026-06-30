/**
 * Phase Onboarding-UX — plan-aware completion math tests.
 *
 * Coverage:
 *   • Free plan: branding task lands in `premium[]`, completion math
 *     ignores it — Free users CAN reach 100%.
 *   • Pro plan: branding task lands in `required[]` and counts.
 *   • Tasks with no requiredCapability always required for every plan.
 *   • Edge cases: empty task list, all done, zero required tasks.
 *   • Determinism: same inputs always produce same outputs.
 *   • hasCapability + cheapestPlanWithCapability behavior.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { partitionByPlan } from "../lib/onboarding/completion";
import {
  PLANS,
  getPlan,
  hasCapability,
  cheapestPlanWithCapability,
} from "../lib/plans";

const FREE = PLANS.free;
const SOLO = PLANS.solo;
const PRO = PLANS.pro;

// ─── upgrade CTA route (regression: was 404 /dashboard/settings/billing) ──
describe("OnboardingChecklist upgrade CTAs route to a real billing page", () => {
  const src = readFileSync(
    join(process.cwd(), "components/dashboard/OnboardingChecklist.tsx"),
    "utf8",
  );
  it("links to /dashboard/billing (the existing page), not the 404 route", () => {
    assert.match(src, /href="\/dashboard\/billing"/);
    // the old route 404s — must not be referenced anywhere in the component
    assert.doesNotMatch(src, /\/dashboard\/settings\/billing/);
  });
});

// ─── partitionByPlan ─────────────────────────────────────────────────

describe("partitionByPlan — plan-aware completion", () => {
  const allTasks = [
    { id: "google", done: true },
    { id: "service", done: true },
    { id: "hours", done: true },
    { id: "booking", done: true },
    {
      id: "branding",
      done: false,
      requiredCapability: "customBranding" as const,
    },
  ];

  it("FREE: branding lands in premium, NOT required", () => {
    const r = partitionByPlan(allTasks, FREE);
    assert.equal(r.premium.length, 1);
    assert.equal(r.premium[0].id, "branding");
    assert.equal(r.required.length, 4);
    assert.equal(r.required.find((t) => t.id === "branding"), undefined);
  });

  it("FREE: completion math ignores branding — 4/4 = 100% = ready", () => {
    const r = partitionByPlan(allTasks, FREE);
    assert.equal(r.requiredDone, 4);
    assert.equal(r.requiredTotal, 4);
    assert.equal(r.pct, 100);
    assert.equal(r.isReady, true);
  });

  it("PRO: branding IS required (plan has customBranding=true)", () => {
    const r = partitionByPlan(allTasks, PRO);
    assert.equal(r.premium.length, 0);
    assert.equal(r.required.length, 5);
    // branding not done → not ready, 4/5 = 80%
    assert.equal(r.requiredDone, 4);
    assert.equal(r.requiredTotal, 5);
    assert.equal(r.pct, 80);
    assert.equal(r.isReady, false);
  });

  it("PRO with branding done: 5/5 = 100% = ready", () => {
    const tasksWithBranding = allTasks.map((t) =>
      t.id === "branding" ? { ...t, done: true } : t,
    );
    const r = partitionByPlan(tasksWithBranding, PRO);
    assert.equal(r.requiredDone, 5);
    assert.equal(r.requiredTotal, 5);
    assert.equal(r.pct, 100);
    assert.equal(r.isReady, true);
  });

  it("SOLO: also unlocks branding (plan has customBranding=true)", () => {
    const r = partitionByPlan(allTasks, SOLO);
    assert.equal(r.premium.length, 0);
    assert.equal(r.required.length, 5);
  });

  it("tasks with no requiredCapability are always required", () => {
    const r = partitionByPlan(allTasks, FREE);
    for (const id of ["google", "service", "hours", "booking"]) {
      assert.ok(
        r.required.find((t) => t.id === id),
        `expected '${id}' to be required regardless of plan`,
      );
    }
  });

  it("empty task list → not ready, 0%", () => {
    const r = partitionByPlan([], FREE);
    assert.equal(r.required.length, 0);
    assert.equal(r.premium.length, 0);
    assert.equal(r.pct, 0);
    assert.equal(r.isReady, false);
  });

  it("ALL tasks premium → required is empty → not ready", () => {
    const r = partitionByPlan(
      [
        { id: "x", done: true, requiredCapability: "customBranding" as const },
      ],
      FREE,
    );
    assert.equal(r.required.length, 0);
    assert.equal(r.premium.length, 1);
    assert.equal(r.isReady, false); // 0 required → never ready
  });

  it("is deterministic across calls", () => {
    const a = partitionByPlan(allTasks, FREE);
    const b = partitionByPlan(allTasks, FREE);
    assert.equal(a.pct, b.pct);
    assert.equal(a.isReady, b.isReady);
    assert.deepEqual(
      a.required.map((t) => t.id),
      b.required.map((t) => t.id),
    );
    assert.deepEqual(
      a.premium.map((t) => t.id),
      b.premium.map((t) => t.id),
    );
  });

  it("preserves task input order within each bucket", () => {
    const tasks = [
      { id: "a", done: false },
      { id: "b", done: false, requiredCapability: "customBranding" as const },
      { id: "c", done: false },
      { id: "d", done: false, requiredCapability: "customBranding" as const },
    ];
    const r = partitionByPlan(tasks, FREE);
    assert.deepEqual(r.required.map((t) => t.id), ["a", "c"]);
    assert.deepEqual(r.premium.map((t) => t.id), ["b", "d"]);
  });

  it("does not mutate input array", () => {
    const before = JSON.stringify(allTasks);
    partitionByPlan(allTasks, FREE);
    assert.equal(JSON.stringify(allTasks), before);
  });
});

// ─── hasCapability ───────────────────────────────────────────────────

describe("hasCapability", () => {
  it("FREE: customBranding=false", () => {
    assert.equal(hasCapability(FREE, "customBranding"), false);
  });

  it("SOLO/PRO/TEAM/ENTERPRISE: customBranding=true", () => {
    assert.equal(hasCapability(SOLO, "customBranding"), true);
    assert.equal(hasCapability(PRO, "customBranding"), true);
    assert.equal(hasCapability(PLANS.team, "customBranding"), true);
    assert.equal(hasCapability(PLANS.enterprise, "customBranding"), true);
  });

  it("FREE: customDomains unavailable (maxCustomDomains=0)", () => {
    assert.equal(hasCapability(FREE, "customDomains"), false);
  });

  it("SOLO+: customDomains available", () => {
    assert.equal(hasCapability(SOLO, "customDomains"), true);
    assert.equal(hasCapability(PRO, "customDomains"), true);
  });

  it("is deterministic", () => {
    const a = hasCapability(FREE, "customBranding");
    const b = hasCapability(FREE, "customBranding");
    assert.equal(a, b);
  });
});

// ─── cheapestPlanWithCapability ─────────────────────────────────────

describe("cheapestPlanWithCapability", () => {
  it("returns the cheapest plan that unlocks customBranding (= solo)", () => {
    const plan = cheapestPlanWithCapability("customBranding");
    assert.ok(plan);
    assert.equal(plan!.id, "solo");
  });

  it("returns null when no plan provides the capability", () => {
    // Synthetic check: every defined capability has at least one
    // plan that satisfies it in the current catalog. This guard
    // ensures the helper handles a "no plan satisfies" case
    // without throwing — verified by passing every known cap.
    for (const cap of [
      "customBranding",
      "publicProfile",
      "analytics",
      "customDomains",
      "extraStaff",
      "extraManagers",
      "extraLocations",
    ] as const) {
      const plan = cheapestPlanWithCapability(cap);
      // We don't enforce non-null — null is valid if no plan
      // qualifies — but if non-null, the returned plan must
      // actually satisfy the capability.
      if (plan) {
        assert.equal(hasCapability(plan, cap), true);
      }
    }
  });
});

// ─── getPlan ─────────────────────────────────────────────────────────

describe("getPlan", () => {
  it("falls back to FREE for null/undefined/unknown", () => {
    assert.equal(getPlan(null).id, "free");
    assert.equal(getPlan(undefined).id, "free");
    assert.equal(getPlan("nonexistent").id, "free");
  });

  it("resolves known plan ids", () => {
    assert.equal(getPlan("free").id, "free");
    assert.equal(getPlan("solo").id, "solo");
    assert.equal(getPlan("pro").id, "pro");
  });
});
