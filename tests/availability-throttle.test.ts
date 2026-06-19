/**
 * Run: npm test
 *
 * "Show Fewer Open Slots" — the deterministic public-availability throttle.
 * Covers the spec's verification cases 1–6 + determinism + spread + safety
 * (output ⊆ input, ascending, never invents a slot).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  throttleSlots,
  isAvailabilityDisplayMode,
  AVAILABILITY_DISPLAY_MODES,
} from "../lib/availability-throttle";

/** N hourly slots starting 09:00 UTC on a fixed day. */
function daySlots(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const h = String(9 + i).padStart(2, "0");
    return `2026-06-20T${h}:00:00.000Z`;
  });
}

describe("throttleSlots — counts per mode", () => {
  const slots = daySlots(10);
  it("normal shows 100% (case 1)", () => {
    assert.deepEqual(throttleSlots(slots, "normal", 3), slots);
  });
  it("balanced ≈ 60% (case 2)", () => {
    assert.equal(throttleSlots(slots, "balanced", 1).length, 6); // ceil(10*0.6)
  });
  it("limited ≈ 35%, fewer than balanced (case 3)", () => {
    assert.equal(throttleSlots(slots, "limited", 1).length, 4); // ceil(10*0.35)
  });
  it("very_limited ≈ 20%, the fewest (case 4)", () => {
    assert.equal(throttleSlots(slots, "very_limited", 1).length, 2); // ceil(10*0.2)
  });
  it("strict ordering very_limited < limited < balanced < normal", () => {
    const n = (m: Parameters<typeof throttleSlots>[1]) => throttleSlots(slots, m, 1).length;
    assert.ok(n("very_limited") < n("limited"));
    assert.ok(n("limited") < n("balanced"));
    assert.ok(n("balanced") < n("normal"));
  });
});

describe("throttleSlots — minimum visible per day", () => {
  it("respects the minimum when enough real slots exist (case 5)", () => {
    // very_limited on 10 → ceil(2)=2, but min 5 lifts it to 5.
    assert.equal(throttleSlots(daySlots(10), "very_limited", 5).length, 5);
  });
  it("shows ALL when total ≤ minimum (case 6: 2 slots, min 3 → both)", () => {
    const two = daySlots(2);
    assert.deepEqual(throttleSlots(two, "very_limited", 3), two);
  });
  it("shows all when total == minimum", () => {
    const three = daySlots(3);
    assert.deepEqual(throttleSlots(three, "limited", 3), three);
  });
  it("empty stays empty", () => {
    assert.deepEqual(throttleSlots([], "limited", 3), []);
  });
});

describe("throttleSlots — deterministic, spread, safe", () => {
  const slots = daySlots(12);
  it("is deterministic — same input → same output (case 10: no refresh churn)", () => {
    assert.deepEqual(
      throttleSlots(slots, "balanced", 3),
      throttleSlots(slots, "balanced", 3),
    );
  });
  it("output is a subset of input, ascending, no invented slots", () => {
    const out = throttleSlots(slots, "limited", 1);
    for (const s of out) assert.ok(slots.includes(s));
    const sorted = [...out].sort();
    assert.deepEqual(out, sorted); // preserves chronological order
  });
  it("spreads across the day — NOT just the first N", () => {
    const out = throttleSlots(slots, "balanced", 1); // 12 → 8 (wait: ceil(12*.6)=8)
    assert.notDeepEqual(out, slots.slice(0, out.length)); // not the leading run
    // keeps an afternoon slot (one from the back third of the day)
    const backThird = slots.slice(8);
    assert.ok(out.some((s) => backThird.includes(s)));
    // keeps a morning slot (one from the front third)
    const frontThird = slots.slice(0, 4);
    assert.ok(out.some((s) => frontThird.includes(s)));
  });
});

describe("isAvailabilityDisplayMode", () => {
  it("accepts the four modes, rejects others", () => {
    for (const m of AVAILABILITY_DISPLAY_MODES) assert.ok(isAvailabilityDisplayMode(m));
    assert.equal(isAvailabilityDisplayMode("aggressive"), false);
    assert.equal(isAvailabilityDisplayMode(null), false);
    assert.equal(isAvailabilityDisplayMode(undefined), false);
  });
});
