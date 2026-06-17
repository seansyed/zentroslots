import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldProcessResponse } from "../src/lib/notificationDedup";

/**
 * P1 reliability: a notification tap must be processed (navigated) EXACTLY ONCE
 * across cold-start / background / foreground. getLastNotificationResponseAsync
 * persistently replays the last tap on every relaunch, so a plain cold launch
 * was re-navigating. These pin the dedup decision.
 */

test("new id, nothing handled → process", () => {
  assert.equal(shouldProcessResponse("n1", new Set(), null), true);
});

test("id already handled THIS session → skip (no duplicate navigation)", () => {
  assert.equal(shouldProcessResponse("n1", new Set(["n1"]), null), false);
});

test("id === persisted last-handled → skip (cold-start re-fire prevented)", () => {
  assert.equal(shouldProcessResponse("n1", new Set(), "n1"), false);
});

test("a genuinely new tap (different from persisted) is processed", () => {
  assert.equal(shouldProcessResponse("n2", new Set(), "n1"), true);
});

test("no identifier → process (never drop a real tap)", () => {
  assert.equal(shouldProcessResponse(null, new Set(), "n1"), true);
  assert.equal(shouldProcessResponse(undefined, new Set(), null), true);
});

test("end-to-end: handle once, then every replay is skipped, but a new tap fires", () => {
  const handled = new Set<string>();
  // Cold launch from a tap on n1 → process; the hook adds n1 to the set + persists it.
  assert.equal(shouldProcessResponse("n1", handled, null), true);
  handled.add("n1");
  // Same session, the response listener also fires for that launch tap → skip.
  assert.equal(shouldProcessResponse("n1", handled, null), false);
  // Next cold start (fresh session = empty set, persisted "n1"), plain relaunch → skip.
  assert.equal(shouldProcessResponse("n1", new Set(), "n1"), false);
  // Next cold start with a NEW tap n2 → process.
  assert.equal(shouldProcessResponse("n2", new Set(), "n1"), true);
});
