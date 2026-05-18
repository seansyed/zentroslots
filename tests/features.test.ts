/**
 * Unit tests for the pure parts of lib/features.ts.
 *
 * The cache + DB load (`loadTenantFeatures`) is exercised in the
 * production smoke phase. Here we only test `mergeFlags`, which is the
 * function that decides what a tenant's resolved flag set looks like
 * given an arbitrary jsonb value in the row.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_FEATURE_FLAGS,
  FEATURE_FLAGS,
  mergeFlags,
} from "../lib/features";

describe("features: mergeFlags", () => {
  it("returns defaults for null/undefined/non-object input", () => {
    assert.deepEqual(mergeFlags(null), DEFAULT_FEATURE_FLAGS);
    assert.deepEqual(mergeFlags(undefined), DEFAULT_FEATURE_FLAGS);
    assert.deepEqual(mergeFlags("not an object"), DEFAULT_FEATURE_FLAGS);
    assert.deepEqual(mergeFlags(42), DEFAULT_FEATURE_FLAGS);
    assert.deepEqual(mergeFlags([true, false]), DEFAULT_FEATURE_FLAGS);
  });

  it("preserves a fully-on default when given an empty object", () => {
    const result = mergeFlags({});
    for (const k of FEATURE_FLAGS) {
      assert.equal(result[k], true, `${k} should default ON`);
    }
  });

  it("honors explicit booleans in the input", () => {
    const result = mergeFlags({ reminders: false, cancellations: false });
    assert.equal(result.reminders, false);
    assert.equal(result.cancellations, false);
    // Untouched keys keep their defaults.
    assert.equal(result.rescheduling, true);
    assert.equal(result.intakeForms, true);
    assert.equal(result.googleMeet, true);
  });

  it("ignores non-boolean values for known keys", () => {
    // Type drift in the jsonb column shouldn't poison the result —
    // string/number/null on a known key falls back to the default.
    const result = mergeFlags({
      reminders: "false",
      cancellations: 0,
      rescheduling: null,
    });
    assert.equal(result.reminders, true);
    assert.equal(result.cancellations, true);
    assert.equal(result.rescheduling, true);
  });

  it("silently drops unknown keys", () => {
    // No fake toggles — keys not in the closed union are non-events.
    const result = mergeFlags({
      reminders: false,
      waitlists: true,            // not a real flag
      recurringBookings: false,   // not a real flag
      zoom: true,                 // not a real flag
    });
    assert.equal(result.reminders, false);
    // The result type is a closed record — unknown keys shouldn't
    // appear on it. Check via property enumeration.
    const keys = Object.keys(result).sort();
    assert.deepEqual(keys, [...FEATURE_FLAGS].sort());
  });

  it("returns a new object — does not mutate input or defaults", () => {
    const input = { reminders: false };
    const result = mergeFlags(input);
    result.reminders = true;
    assert.equal(input.reminders, false, "input was mutated");
    assert.equal(DEFAULT_FEATURE_FLAGS.reminders, true, "defaults were mutated");
  });
});
