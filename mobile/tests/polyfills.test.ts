import { test } from "node:test";
import assert from "node:assert/strict";

import { findLastImpl, findLastIndexImpl, atImpl, installArrayPolyfills } from "../src/lib/polyfills";

// Regression coverage for the Android release boot crash: Hermes lacks
// Array.prototype.findLast / findLastIndex, which @react-navigation calls on
// the first navigation action. These verify the polyfill bodies match native
// semantics (Node/V8 provides the natives, so we test the impls directly).

test("findLastImpl returns the last matching element (high → low)", () => {
  const arr = [{ k: 1 }, { k: 2 }, { k: 2 }, { k: 3 }];
  const got = findLastImpl(arr, (x) => x.k === 2);
  assert.equal(got, arr[2]); // the LAST k===2, not the first
  assert.equal(findLastImpl([1, 2, 3], (x) => x < 3), 2);
  assert.equal(findLastImpl([1, 2, 3], (x) => x > 9), undefined);
  // Matches the native implementation exactly.
  assert.equal(
    findLastImpl([5, 4, 3, 2, 1], (x) => x % 2 === 0),
    [5, 4, 3, 2, 1].findLast((x) => x % 2 === 0),
  );
});

test("findLastIndexImpl returns the last matching index, -1 when none", () => {
  assert.equal(findLastIndexImpl([1, 2, 2, 3], (x) => x === 2), 2);
  assert.equal(findLastIndexImpl([1, 2, 3], (x) => x > 9), -1);
  assert.equal(findLastIndexImpl([], () => true), -1);
  assert.equal(
    findLastIndexImpl(["a", "b", "a"], (x) => x === "a"),
    ["a", "b", "a"].findLastIndex((x) => x === "a"),
  );
});

test("findLastImpl/findLastIndexImpl pass index + array to the predicate", () => {
  const seen: number[] = [];
  findLastImpl([10, 20, 30], (_v, i, a) => {
    seen.push(i);
    assert.equal(a.length, 3);
    return false;
  });
  assert.deepEqual(seen, [2, 1, 0]); // iterates from the end
});

test("findLastImpl throws TypeError for a non-function predicate (spec)", () => {
  // @ts-expect-error intentionally wrong type
  assert.throws(() => findLastImpl([1], 123), TypeError);
});

test("atImpl supports negative indices like the native", () => {
  assert.equal(atImpl([1, 2, 3], -1), 3);
  assert.equal(atImpl([1, 2, 3], 0), 1);
  assert.equal(atImpl([1, 2, 3], 5), undefined);
  assert.equal(atImpl([1, 2, 3], -9), undefined);
});

test("installArrayPolyfills is a no-op on an engine that already has them", () => {
  // Node/V8 provides all three, so nothing should be added here.
  const added = installArrayPolyfills();
  assert.deepEqual(added, []);
  // And the natives still work after a (no-op) install.
  assert.equal([1, 2, 2].findLastIndex((x) => x === 2), 2);
});
