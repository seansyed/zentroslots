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

describe("throttleSlots — mode fraction (cap not binding: total > max ≥ modeCount)", () => {
  // The 3rd arg is now a MAXIMUM. To exercise the MODE fraction (not the cap),
  // we need total > max (so "show all" doesn't fire) AND max ≥ each mode count.
  // 40 slots, max 39: balanced 24, limited 14, very_limited 8 — all uncapped.
  const slots = daySlots(40);
  it("normal shows 100%", () => {
    assert.deepEqual(throttleSlots(slots, "normal", 39), slots);
  });
  it("balanced ≈ 60%", () => {
    assert.equal(throttleSlots(slots, "balanced", 39).length, 24); // ceil(40*0.6)
  });
  it("limited ≈ 35%, fewer than balanced", () => {
    assert.equal(throttleSlots(slots, "limited", 39).length, 14); // ceil(40*0.35)
  });
  it("very_limited ≈ 20%, the fewest", () => {
    assert.equal(throttleSlots(slots, "very_limited", 39).length, 8); // ceil(40*0.2)
  });
  it("strict ordering very_limited < limited < balanced < normal", () => {
    const n = (m: Parameters<typeof throttleSlots>[1]) => throttleSlots(slots, m, 39).length;
    assert.ok(n("very_limited") < n("limited"));
    assert.ok(n("limited") < n("balanced"));
    assert.ok(n("balanced") < n("normal"));
  });
});

describe("throttleSlots — maximum visible per day (the cap)", () => {
  it("caps very_limited at the max (the reported bug: 31 slots, max 4 → 4, not 7)", () => {
    assert.equal(throttleSlots(daySlots(31), "very_limited", 4).length, 4);
  });
  it("caps EVERY mode at the max when the max is the binding constraint", () => {
    for (const m of ["balanced", "limited", "very_limited"] as const) {
      assert.ok(throttleSlots(daySlots(31), m, 4).length <= 4, `${m} must not exceed 4`);
    }
  });
  it("uses the lower count when the mode count is below the max", () => {
    // very_limited on 31 → ceil(6.2)=7; max 20 doesn't bind → 7 (< max).
    assert.equal(throttleSlots(daySlots(31), "very_limited", 20).length, 7);
  });
  it("never shows more than the configured maximum", () => {
    for (const max of [1, 2, 4, 8]) {
      for (const m of ["balanced", "limited", "very_limited"] as const) {
        assert.ok(throttleSlots(daySlots(31), m, max).length <= max);
      }
    }
  });
  it("shows at least 1 slot when availability exists and mode is on", () => {
    assert.ok(throttleSlots(daySlots(31), "very_limited", 1).length >= 1);
    assert.equal(throttleSlots(daySlots(31), "very_limited", 1).length, 1);
  });
  it("shows ALL when total ≤ maximum (2 slots, max 4 → both)", () => {
    const two = daySlots(2);
    assert.deepEqual(throttleSlots(two, "very_limited", 4), two);
  });
  it("shows all when total == maximum", () => {
    const three = daySlots(3);
    assert.deepEqual(throttleSlots(three, "limited", 3), three);
  });
  it("floors a 0/negative max to 1 (0 is not a valid cap)", () => {
    assert.equal(throttleSlots(daySlots(31), "very_limited", 0).length, 1);
  });
  it("empty stays empty", () => {
    assert.deepEqual(throttleSlots([], "limited", 4), []);
  });
});

describe("throttleSlots — deterministic, spread, safe", () => {
  const slots = daySlots(31); // total > max below, so the throttle actually runs
  it("is deterministic — same input → same output (no refresh churn)", () => {
    assert.deepEqual(
      throttleSlots(slots, "balanced", 8),
      throttleSlots(slots, "balanced", 8),
    );
  });
  it("output is a subset of input, ascending, no invented slots", () => {
    const out = throttleSlots(slots, "limited", 20); // 31 > 20 → throttles
    assert.ok(out.length < slots.length);
    for (const s of out) assert.ok(slots.includes(s));
    const sorted = [...out].sort();
    assert.deepEqual(out, sorted); // preserves chronological order
  });
  it("spreads across the day — NOT just the first N (mode-driven, max=20 → 19)", () => {
    const out = throttleSlots(slots, "balanced", 20); // min(ceil(31*.6)=19, 20)=19
    assert.notDeepEqual(out, slots.slice(0, out.length)); // not the leading run
    const backThird = slots.slice(21);
    assert.ok(out.some((s) => backThird.includes(s)));
    const frontThird = slots.slice(0, 10);
    assert.ok(out.some((s) => frontThird.includes(s)));
  });
  it("spread still holds when the MAX is the binding constraint (31 → 4)", () => {
    const out = throttleSlots(slots, "very_limited", 4);
    assert.equal(out.length, 4);
    assert.ok(out.every((s) => slots.includes(s)));
    assert.deepEqual(out, [...out].sort());
    assert.notDeepEqual(out, slots.slice(0, 4)); // spread, not first 4
  });
});

describe("public booking POST enforcement (app/api/bookings)", () => {
  // The booking endpoint rejects a public/client booking when the requested
  // slot is NOT in the SAME throttled list /api/slots showed. It reuses
  // throttleSlots() with the same inputs, so "bookable publicly" must equal
  // "visible". These tests lock that membership contract — the gap closed is
  // a hidden-but-real slot being bookable via a direct POST.
  const filtered = daySlots(31); // a real day's available+rule-filtered slots
  const isPubliclyBookable = (
    slot: string,
    mode: Parameters<typeof throttleSlots>[1],
    max: number,
  ) => throttleSlots(filtered, mode, max).includes(slot);

  it("rejects a real-but-hidden slot for a throttled public booking", () => {
    const visible = throttleSlots(filtered, "very_limited", 4);
    const hidden = filtered.filter((s) => !visible.includes(s));
    assert.ok(hidden.length > 0, "throttle must hide at least one real slot");
    for (const s of hidden) {
      assert.equal(isPubliclyBookable(s, "very_limited", 4), false);
    }
  });

  it("allows every visible slot for a throttled public booking", () => {
    const visible = throttleSlots(filtered, "balanced", 4);
    for (const s of visible) {
      assert.equal(isPubliclyBookable(s, "balanced", 4), true);
    }
  });

  it("max ≥ total shows all → no slot is hidden (booking unaffected)", () => {
    const visible = throttleSlots(filtered, "very_limited", 40);
    assert.deepEqual(visible, filtered);
    for (const s of filtered) {
      assert.equal(isPubliclyBookable(s, "very_limited", 40), true);
    }
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
