/**
 * Tests for the Expo push receipt classifier (Phase 1D — invalid-token pruning).
 *
 * fetchExpoPushReceipts is the authoritative delivery check; this is where
 * DeviceNotRegistered surfaces for tokens that died after registration. The
 * receipts worker deletes the token ONLY on a tokenInvalid receipt, leaves
 * 'sent' on transient/pending, and marks 'delivered' on ok.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchExpoPushReceipts } from "../lib/push/sender";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(payload: unknown, ok = true, status = 200) {
  globalThis.fetch = (async () =>
    ({
      ok,
      status,
      json: async () => payload,
    }) as unknown as Response) as typeof fetch;
}

test("ok receipt → status ok (delivered)", async () => {
  mockFetch({ data: { "r-1": { status: "ok" } } });
  const r = await fetchExpoPushReceipts(["r-1"]);
  assert.equal(r["r-1"]!.status, "ok");
});

test("DeviceNotRegistered receipt → error + tokenInvalid (prune the token)", async () => {
  mockFetch({ data: { "r-2": { status: "error", message: "dead", details: { error: "DeviceNotRegistered" } } } });
  const r = await fetchExpoPushReceipts(["r-2"]);
  const v = r["r-2"]!;
  assert.equal(v.status, "error");
  assert.equal(v.status === "error" && v.tokenInvalid, true);
  assert.equal(v.status === "error" && v.transient, false);
});

test("MessageRateExceeded receipt → transient (re-check, do NOT prune)", async () => {
  mockFetch({ data: { "r-3": { status: "error", message: "slow down", details: { error: "MessageRateExceeded" } } } });
  const r = await fetchExpoPushReceipts(["r-3"]);
  const v = r["r-3"]!;
  assert.equal(v.status, "error");
  assert.equal(v.status === "error" && v.transient, true);
  assert.equal(v.status === "error" && v.tokenInvalid, false);
});

test("receipt id absent from response → pending (leave 'sent', re-check)", async () => {
  mockFetch({ data: {} });
  const r = await fetchExpoPushReceipts(["r-4"]);
  assert.equal(r["r-4"]!.status, "pending");
});

test("network/5xx → every requested id is transient error (never prune on outage)", async () => {
  mockFetch({}, false, 503);
  const r = await fetchExpoPushReceipts(["r-5", "r-6"]);
  for (const id of ["r-5", "r-6"]) {
    const v = r[id]!;
    assert.equal(v.status, "error");
    assert.equal(v.status === "error" && v.transient, true);
    assert.equal(v.status === "error" && v.tokenInvalid, false);
  }
});

test("fetch throws → transient (fail-safe, never throws out)", async () => {
  globalThis.fetch = (async () => {
    throw new Error("boom");
  }) as typeof fetch;
  const r = await fetchExpoPushReceipts(["r-7"]);
  assert.equal(r["r-7"]!.status, "error");
  assert.equal(r["r-7"]!.status === "error" && r["r-7"]!.transient, true);
});
