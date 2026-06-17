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

import { fetchExpoPushReceipts, sendExpoPushBatch } from "../lib/push/sender";

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

// ─── P1 reliability: InvalidCredentials must NEVER delete a token ──────────
// A server-wide APNs/FCM credential fault is returned PER-MESSAGE for every
// recipient. Classifying it as a per-token failure would wipe the whole token
// table on one misconfig. It must be a credentialError (retry + alert), never
// tokenInvalid (delete). Only DeviceNotRegistered deletes a token.

test("RECEIPT InvalidCredentials → credentialError, NOT tokenInvalid (token preserved)", async () => {
  mockFetch({ data: { "r-c": { status: "error", message: "bad creds", details: { error: "InvalidCredentials" } } } });
  const r = await fetchExpoPushReceipts(["r-c"]);
  const v = r["r-c"]!;
  assert.equal(v.status, "error");
  assert.equal(v.status === "error" && v.tokenInvalid, false, "must NOT be tokenInvalid (would delete the token)");
  assert.equal(v.status === "error" && v.credentialError, true);
  assert.equal(v.status === "error" && v.transient, true, "must be retryable");
});

test("SEND InvalidCredentials → credentialError, NOT tokenInvalid (first prod send can't wipe the table)", async () => {
  mockFetch({ data: [{ status: "error", message: "bad creds", details: { error: "InvalidCredentials" } }] });
  const [res] = await sendExpoPushBatch([{ to: "ExponentPushToken[x]", title: "t", body: "b" }]);
  assert.equal(res!.status, "error");
  assert.equal(res!.status === "error" && res!.tokenInvalid, false, "InvalidCredentials must never delete a token");
  assert.equal(res!.status === "error" && res!.credentialError, true);
  assert.equal(res!.status === "error" && res!.transient, true);
});

test("SEND DeviceNotRegistered → tokenInvalid (the ONLY delete), not a credentialError", async () => {
  mockFetch({ data: [{ status: "error", message: "dead", details: { error: "DeviceNotRegistered" } }] });
  const [res] = await sendExpoPushBatch([{ to: "ExponentPushToken[y]", title: "t", body: "b" }]);
  assert.equal(res!.status === "error" && res!.tokenInvalid, true);
  assert.equal(res!.status === "error" && res!.credentialError, false);
});

test("SEND MessageRateExceeded → transient retry, never a token-delete", async () => {
  mockFetch({ data: [{ status: "error", message: "slow", details: { error: "MessageRateExceeded" } }] });
  const [res] = await sendExpoPushBatch([{ to: "ExponentPushToken[z]", title: "t", body: "b" }]);
  assert.equal(res!.status === "error" && res!.transient, true);
  assert.equal(res!.status === "error" && res!.tokenInvalid, false);
  assert.equal(res!.status === "error" && res!.credentialError, false);
});

test("SEND network failure → transient, token preserved", async () => {
  mockFetch({}, false, 503);
  const [res] = await sendExpoPushBatch([{ to: "ExponentPushToken[n]", title: "t", body: "b" }]);
  assert.equal(res!.status === "error" && res!.transient, true);
  assert.equal(res!.status === "error" && res!.tokenInvalid, false);
});
