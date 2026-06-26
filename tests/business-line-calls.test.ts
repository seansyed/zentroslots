/**
 * Business Line call-logs helpers (increment 5). Pure tests: query parsing
 * (defaults, limit clamp, validation), SAFE row shaping (no raw payloads /
 * Telnyx IDs leak), duration formatting, and status label/tone. No DB/network.
 *
 * Run: `npx tsx --test tests/business-line-calls.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseCallLogQuery,
  shapeCallLogRow,
  callStatusLabel,
  callStatusTone,
  formatCallDuration,
  CALL_LOG_LIMIT_DEFAULT,
  CALL_LOG_LIMIT_MAX,
} from "../lib/business-line-calls";

// ── query parsing ──────────────────────────────────────────────────
test("parseCallLogQuery: safe defaults when no params", () => {
  const r = parseCallLogQuery({});
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.query.limit, CALL_LOG_LIMIT_DEFAULT);
  assert.equal(r.ok && r.query.offset, 0);
  assert.equal(r.ok && r.query.status, null);
  assert.equal(r.ok && r.query.direction, null);
  assert.equal(r.ok && r.query.from, null);
});

test("parseCallLogQuery: limit clamps to max; validates integers", () => {
  assert.equal((parseCallLogQuery({ limit: "500" }) as { query: { limit: number } }).query.limit, CALL_LOG_LIMIT_MAX);
  assert.equal((parseCallLogQuery({ limit: "10" }) as { query: { limit: number } }).query.limit, 10);
  assert.deepEqual(parseCallLogQuery({ limit: "-1" }), { ok: false, error: "limit must be a positive integer" });
  assert.deepEqual(parseCallLogQuery({ limit: "abc" }), { ok: false, error: "limit must be a positive integer" });
  assert.deepEqual(parseCallLogQuery({ offset: "-5" }), { ok: false, error: "offset must be a non-negative integer" });
});

test("parseCallLogQuery: status filter — valid, 'all', and invalid", () => {
  assert.equal((parseCallLogQuery({ status: "missed" }) as { query: { status: string } }).query.status, "missed");
  assert.equal((parseCallLogQuery({ status: "completed" }) as { query: { status: string } }).query.status, "completed");
  assert.equal((parseCallLogQuery({ status: "all" }) as { query: { status: string | null } }).query.status, null);
  assert.deepEqual(parseCallLogQuery({ status: "bogus" }), { ok: false, error: "invalid status filter" });
});

test("parseCallLogQuery: direction + date range validation", () => {
  assert.equal((parseCallLogQuery({ direction: "inbound" }) as { query: { direction: string } }).query.direction, "inbound");
  assert.deepEqual(parseCallLogQuery({ direction: "sideways" }), { ok: false, error: "invalid direction filter" });
  const ok = parseCallLogQuery({ from: "2026-06-01T00:00:00Z", to: "2026-07-01T00:00:00Z" });
  assert.equal(ok.ok, true);
  assert.ok(ok.ok && ok.query.from instanceof Date);
  assert.deepEqual(parseCallLogQuery({ from: "not-a-date" }), { ok: false, error: "invalid from date" });
});

test("parseCallLogQuery: works with URLSearchParams too", () => {
  const r = parseCallLogQuery(new URLSearchParams({ limit: "5", status: "failed" }));
  assert.equal(r.ok && r.query.limit, 5);
  assert.equal(r.ok && r.query.status, "failed");
});

// ── safe shaping (no leakage) ──────────────────────────────────────
test("shapeCallLogRow exposes ONLY safe fields — no Telnyx IDs / metadata / payload", () => {
  const row = {
    id: "c1",
    fromNumber: "+19998887777",
    toNumber: "+14155550100",
    forwardedToNumber: "+16475550123",
    status: "completed",
    startedAt: new Date("2026-06-26T12:00:00Z"),
    answeredAt: new Date("2026-06-26T12:00:05Z"),
    endedAt: new Date("2026-06-26T12:01:35Z"),
    durationSeconds: 90,
    billableSeconds: 120,
    costEstimateCents: 4,
    // sensitive / internal fields that MUST NOT appear in the output:
    telnyxCallSessionId: "sess_secret",
    telnyxCallControlId: "cc_secret",
    telnyxCallLegId: "leg_secret",
    metadata: { secret: true },
    rawPayload: { foo: "bar" },
    signatureHeaders: { "telnyx-signature-ed25519": "x" },
  } as Parameters<typeof shapeCallLogRow>[0] & Record<string, unknown>;

  const out = shapeCallLogRow(row);
  const keys = Object.keys(out).sort();
  assert.deepEqual(keys, [
    "answeredAt",
    "billableSeconds",
    "costEstimateCents",
    "durationSeconds",
    "endedAt",
    "forwardedToNumber",
    "fromNumber",
    "id",
    "missed",
    "startedAt",
    "status",
    "toNumber",
  ]);
  // explicitly assert no leak of any sensitive key
  for (const k of ["telnyxCallSessionId", "telnyxCallControlId", "telnyxCallLegId", "metadata", "rawPayload", "signatureHeaders"]) {
    assert.equal(k in out, false, `${k} must not leak`);
  }
  assert.equal(out.startedAt, "2026-06-26T12:00:00.000Z");
  assert.equal(out.missed, false);
});

test("shapeCallLogRow flags missed + no_forwarding", () => {
  assert.equal(shapeCallLogRow({ id: "a", status: "missed" }).missed, true);
  assert.equal(shapeCallLogRow({ id: "b", status: "no_forwarding" }).missed, true);
  assert.equal(shapeCallLogRow({ id: "c", status: "completed" }).missed, false);
});

// ── display helpers ────────────────────────────────────────────────
test("formatCallDuration: m:ss, dash for none", () => {
  assert.equal(formatCallDuration(null), "—");
  assert.equal(formatCallDuration(0), "—");
  assert.equal(formatCallDuration(5), "0:05");
  assert.equal(formatCallDuration(60), "1:00");
  assert.equal(formatCallDuration(75), "1:15");
  assert.equal(formatCallDuration(605), "10:05");
});

test("callStatusLabel + callStatusTone for answered/missed/etc.", () => {
  assert.equal(callStatusLabel("completed"), "Completed");
  assert.equal(callStatusLabel("missed"), "Missed");
  assert.equal(callStatusLabel("no_forwarding"), "No forwarding");
  assert.equal(callStatusTone("completed"), "green");
  assert.equal(callStatusTone("answered"), "green");
  assert.equal(callStatusTone("missed"), "red");
  assert.equal(callStatusTone("no_forwarding"), "red");
  assert.equal(callStatusTone("failed"), "amber");
  assert.equal(callStatusTone("rejected"), "amber");
  assert.equal(callStatusTone("ringing"), "neutral");
});
