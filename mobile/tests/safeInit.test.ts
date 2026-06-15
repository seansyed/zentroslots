import { test } from "node:test";
import assert from "node:assert/strict";

import { createRunOnceSafe } from "../src/lib/safeInit";

// Regression coverage for the white-screen fix: the boot-safety primitive
// that wraps optional native init (notification handler) must run once,
// never throw (so a failure can't white-screen render), and be retryable.

test("runs the init at most once on success", () => {
  let n = 0;
  const run = createRunOnceSafe(() => {
    n++;
  });
  assert.equal(run(), true);
  assert.equal(run(), true);
  assert.equal(n, 1); // ran exactly once despite two calls
});

test("contains a throwing init (fail-open) and reports it via onError", () => {
  let calls = 0;
  let errs = 0;
  const run = createRunOnceSafe(
    () => {
      calls++;
      throw new Error("native module not ready");
    },
    () => {
      errs++;
    },
  );
  // Must NOT throw — this is what prevents a white screen on boot.
  assert.doesNotThrow(() => {
    assert.equal(run(), false);
  });
  assert.equal(errs, 1);
  // A failed run is not marked done -> a later call (Retry) tries again.
  assert.equal(run(), false);
  assert.equal(calls, 2);
});

test("retry after failure can succeed, then becomes a no-op", () => {
  let calls = 0;
  let fail = true;
  const run = createRunOnceSafe(() => {
    calls++;
    if (fail) throw new Error("not ready yet");
  });
  assert.equal(run(), false); // 1st attempt fails
  fail = false;
  assert.equal(run(), true); // 2nd attempt (retry) succeeds
  assert.equal(run(), true); // 3rd is a no-op
  assert.equal(calls, 2);
});

test("a throwing onError reporter is itself swallowed", () => {
  const run = createRunOnceSafe(
    () => {
      throw new Error("init boom");
    },
    () => {
      throw new Error("reporter boom");
    },
  );
  assert.doesNotThrow(() => {
    assert.equal(run(), false);
  });
});
