/**
 * Business Line — TeXML wire-format compatibility (increment 7). Proves the
 * webhook parses REAL Telnyx TeXML requests, which are TwiML-compatible
 * **form-encoded** params (From/To/CallSid/CallStatus, and DialCallStatus/
 * DialCallDuration on the <Dial> action callback) — NOT the JSON shape the
 * earlier code assumed. Signature scheme is unchanged (Ed25519 over the raw
 * body). No DB / network / real Telnyx.
 *
 * Run: `npx tsx --test tests/business-line-texml.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import { extractTelnyxCallEvent, type BusinessLineConfig } from "../lib/telnyx-business-line";
import { verifyAndParseInbound, planStatusUpdate } from "../lib/business-line-forwarding";
import { normalizeCallStatus } from "../lib/business-line";

function makeKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyB64: spki.subarray(spki.length - 32).toString("base64") };
}
function sign(pk: KeyObject, ts: string, body: string): string {
  return nodeSign(null, Buffer.from(`${ts}|${body}`, "utf8"), pk).toString("base64");
}
function cfg(publicKeyB64: string): BusinessLineConfig {
  return { enabled: true, publicKey: publicKeyB64, apiKey: null, replayToleranceSeconds: 300 };
}
const BUSINESS = "+14155550100";
const CALLER = "+19998887777";

// ── inbound (form-encoded TeXML) ───────────────────────────────────
test("TeXML inbound (form-encoded) parses To/From/CallSid + ringing", () => {
  const body = new URLSearchParams({
    From: CALLER, To: BUSINESS, CallSid: "CA-1", CallStatus: "ringing", Direction: "inbound", AccountSid: "acc",
  }).toString();
  const ev = extractTelnyxCallEvent(body);
  assert.equal(ev.to, BUSINESS);
  assert.equal(ev.from, CALLER);
  assert.equal(ev.callSessionId, "CA-1");
  assert.equal(normalizeCallStatus(ev.eventType), "ringing");
  assert.equal(ev.eventId, "CA-1:ringing"); // synthesized dedup key
});

test("verifyAndParseInbound accepts a SIGNED TeXML form body (this is the fix)", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = new URLSearchParams({ From: CALLER, To: BUSINESS, CallSid: "CA-1", CallStatus: "ringing" }).toString();
  const ts = "1700000000";
  const vp = verifyAndParseInbound({
    config: cfg(publicKeyB64), rawBody: body, signatureB64: sign(privateKey, ts, body), timestamp: ts, nowSeconds: 1700000000,
  });
  assert.equal(vp.ok, true);
  assert.equal(vp.ok && vp.event.to, BUSINESS); // tenant resolvable from a real TeXML body
});

test("verifyAndParseInbound rejects a tampered TeXML form body", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = new URLSearchParams({ From: CALLER, To: BUSINESS, CallSid: "CA-1" }).toString();
  const ts = "1700000000";
  const sig = sign(privateKey, ts, body);
  const vp = verifyAndParseInbound({
    config: cfg(publicKeyB64), rawBody: body.replace(BUSINESS.slice(1), "15550000000"), signatureB64: sig, timestamp: ts, nowSeconds: 1700000000,
  });
  assert.deepEqual(vp, { ok: false, reason: "bad_signature" });
});

// ── status: <Dial> action callback (form-encoded) ──────────────────
test("TeXML <Dial> action (completed) → completed + billable duration", () => {
  const body = new URLSearchParams({
    CallSid: "CA-1", CallStatus: "completed", DialCallStatus: "completed", DialCallDuration: "95", From: CALLER, To: BUSINESS,
  }).toString();
  const ev = extractTelnyxCallEvent(body);
  assert.equal(ev.durationSeconds, 95); // from DialCallDuration
  assert.equal(normalizeCallStatus(ev.eventType), "completed"); // prefers DialCallStatus
  const p = planStatusUpdate({ currentStatus: "answered", incomingStatusRaw: ev.eventType, durationSeconds: ev.durationSeconds });
  assert.equal(p?.nextStatus, "completed");
  assert.equal(p?.becameTerminal, true);
  assert.equal(p?.billableSeconds, 120); // ceil(95/60)=2 min
  assert.deepEqual(p?.usageDelta, { answeredCalls: 1, missedCalls: 0, billableSeconds: 120, estimatedCostCents: 4 });
});

test("TeXML <Dial> action (no-answer) → missed, no billable", () => {
  const body = new URLSearchParams({ CallSid: "CA-1", DialCallStatus: "no-answer", From: CALLER, To: BUSINESS }).toString();
  const ev = extractTelnyxCallEvent(body);
  assert.equal(normalizeCallStatus(ev.eventType), "missed");
  const p = planStatusUpdate({ currentStatus: "ringing", incomingStatusRaw: ev.eventType });
  assert.equal(p?.nextStatus, "missed");
  assert.deepEqual(p?.usageDelta, { answeredCalls: 0, missedCalls: 1, billableSeconds: 0, estimatedCostCents: 0 });
});

// ── robustness ─────────────────────────────────────────────────────
test("extractTelnyxCallEvent is case-insensitive + alias tolerant", () => {
  const body = "from=%2B19998887777&to=%2B14155550100&callsid=CA-2&callstatus=in-progress";
  const ev = extractTelnyxCallEvent(body);
  assert.equal(ev.from, CALLER);
  assert.equal(ev.to, BUSINESS);
  assert.equal(ev.callSessionId, "CA-2");
  assert.equal(normalizeCallStatus(ev.eventType), "answered");
});

test("extractTelnyxCallEvent still handles the legacy JSON shape (back-compat)", () => {
  const ev = extractTelnyxCallEvent(
    '{"data":{"event_type":"call.hangup","id":"evt1","payload":{"call_session_id":"s","to":"+14155550100","from":"+19998887777","call_duration_secs":"47"}}}',
  );
  assert.equal(ev.callSessionId, "s");
  assert.equal(ev.to, BUSINESS);
  assert.equal(ev.durationSeconds, 47);
  assert.equal(ev.eventType, "call.hangup");
});

test("normalizeCallStatus maps the full TwiML/TeXML status set", () => {
  assert.equal(normalizeCallStatus("queued"), "ringing");
  assert.equal(normalizeCallStatus("ringing"), "ringing");
  assert.equal(normalizeCallStatus("in-progress"), "answered");
  assert.equal(normalizeCallStatus("completed"), "completed");
  assert.equal(normalizeCallStatus("no-answer"), "missed");
  assert.equal(normalizeCallStatus("canceled"), "missed");
  assert.equal(normalizeCallStatus("cancelled"), "missed");
  assert.equal(normalizeCallStatus("busy"), "rejected");
  assert.equal(normalizeCallStatus("failed"), "failed");
});
