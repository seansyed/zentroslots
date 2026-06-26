/**
 * Business Line — SYNTHETIC signed-webhook validation (no real Telnyx, no DB, no
 * calls, no server). Drives the real inbound/status pipeline functions with
 * realistically-shaped Telnyx webhook payloads and locally-generated Ed25519
 * vectors, asserting the exact wire behavior a route would produce:
 *   - a valid signed call.initiated → forwards (TeXML <Dial> w/ business caller ID)
 *   - a tampered signature → rejected
 *   - an unknown called number → reject, no tenant data
 *   - realistic call.answered / call.hangup payloads → correct status + usage
 *
 * This is the closest validation possible without a staging DB/app. The
 * DB-backed route wiring + migration-applied schema + dashboard still require a
 * real staging environment (deferred).
 *
 * Run: `npx tsx --test tests/business-line-webhook-synthetic.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import {
  verifyAndParseInbound,
  decideForwarding,
  texmlForDecision,
  planStatusUpdate,
  type ForwardingContext,
} from "../lib/business-line-forwarding";
import { parseTelnyxCallEvent, type BusinessLineConfig } from "../lib/telnyx-business-line";

// ── local Ed25519 vectors (no real Telnyx key) ─────────────────────
function makeKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyB64: spki.subarray(spki.length - 32).toString("base64") };
}
function sign(privateKey: KeyObject, ts: string, body: string): string {
  return nodeSign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey).toString("base64");
}
function cfg(publicKeyB64: string, enabled = true): BusinessLineConfig {
  return { enabled, publicKey: publicKeyB64, apiKey: null, replayToleranceSeconds: 300 };
}

const TS = "1700000000";
const NOW = 1700000000;
const BUSINESS = "+14155550100";
const CALLER = "+19998887777";
const FORWARD = "+16475550123";

// Realistic Telnyx call-control webhook envelopes.
function callInitiatedBody(to = BUSINESS) {
  return JSON.stringify({
    data: {
      event_type: "call.initiated",
      id: "evt-initiated-1",
      occurred_at: "2026-06-26T17:00:00.000Z",
      payload: {
        call_control_id: "cc-1",
        call_leg_id: "leg-1",
        call_session_id: "sess-1",
        connection_id: "conn-1",
        from: CALLER,
        to,
        direction: "incoming",
        state: "parked",
      },
    },
  });
}
function callAnsweredBody() {
  return JSON.stringify({
    data: {
      event_type: "call.answered",
      id: "evt-answered-1",
      payload: { call_session_id: "sess-1", call_control_id: "cc-1", from: CALLER, to: BUSINESS },
    },
  });
}
function callHangupBody(durationSecs: number) {
  return JSON.stringify({
    data: {
      event_type: "call.hangup",
      id: "evt-hangup-1",
      payload: {
        call_session_id: "sess-1",
        call_control_id: "cc-1",
        from: CALLER,
        to: BUSINESS,
        hangup_cause: "normal_clearing",
        hangup_source: "callee",
        // NOTE: field name for duration must be confirmed against real Telnyx
        // payloads during the staging run — the parser accepts several aliases.
        call_duration_secs: durationSecs,
      },
    },
  });
}

const validCtx: ForwardingContext = {
  tenantMatched: true,
  businessNumber: BUSINESS,
  ownedNumbers: [BUSINESS],
  settingsEnabled: true,
  entitlementActive: true,
  forwardingNumber: FORWARD,
  minutesUsed: 0,
  monthlyMinuteCap: 200,
};

// ── inbound: valid signed call → Dial ──────────────────────────────
test("synthetic inbound: valid signed call.initiated → <Dial> with business caller ID", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = callInitiatedBody();
  const vp = verifyAndParseInbound({
    config: cfg(publicKeyB64),
    rawBody: body,
    signatureB64: sign(privateKey, TS, body),
    timestamp: TS,
    nowSeconds: NOW,
  });
  assert.equal(vp.ok, true);
  assert.equal(vp.ok && vp.event.to, BUSINESS);
  assert.equal(vp.ok && vp.event.from, CALLER);
  assert.equal(vp.ok && vp.event.callSessionId, "sess-1");

  const xml = texmlForDecision(decideForwarding(validCtx), { statusCallbackUrl: "https://staging.test/api/webhooks/telnyx/voice/status" });
  assert.match(xml, /<Dial /);
  assert.match(xml, /callerId="\+14155550100"/); // business number, not the caller
  assert.match(xml, /<Number>\+16475550123<\/Number>/);
  assert.doesNotMatch(xml, new RegExp(CALLER.replace("+", "\\+"))); // caller's number never in the response
});

// ── inbound: tampered signature → rejected ─────────────────────────
test("synthetic inbound: tampered body fails signature → no forward", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = callInitiatedBody();
  const sig = sign(privateKey, TS, body);
  const vp = verifyAndParseInbound({
    config: cfg(publicKeyB64),
    rawBody: body.replace(CALLER, "+10000000000"), // tamper after signing
    signatureB64: sig,
    timestamp: TS,
    nowSeconds: NOW,
  });
  assert.deepEqual(vp, { ok: false, reason: "bad_signature" });
});

// ── inbound: unknown called number → reject, no tenant data ────────
test("synthetic inbound: unknown called number → reject, no leak", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = callInitiatedBody("+15550009999"); // not an assigned business number
  const vp = verifyAndParseInbound({ config: cfg(publicKeyB64), rawBody: body, signatureB64: sign(privateKey, TS, body), timestamp: TS, nowSeconds: NOW });
  assert.equal(vp.ok, true);
  // The route would resolve no tenant → tenantMatched:false.
  const decision = decideForwarding({ ...validCtx, tenantMatched: false, businessNumber: null });
  assert.deepEqual(decision, { action: "reject", reason: "no_tenant" });
  const xml = texmlForDecision(decision);
  assert.match(xml, /<Reject\/>/);
  assert.doesNotMatch(xml, /\+\d/); // no number / tenant data of any kind
});

// ── inbound: flag OFF → disabled, never forwards ───────────────────
test("synthetic inbound: flag OFF short-circuits before any forward", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = callInitiatedBody();
  const vp = verifyAndParseInbound({ config: cfg(publicKeyB64, /* enabled */ false), rawBody: body, signatureB64: sign(privateKey, TS, body), timestamp: TS, nowSeconds: NOW });
  assert.deepEqual(vp, { ok: false, reason: "disabled" });
});

// ── status: realistic answered/hangup payloads → status + usage ────
test("synthetic status: call.answered then call.hangup → completed + billable usage", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();

  // answered
  const ans = callAnsweredBody();
  const vpA = verifyAndParseInbound({ config: cfg(publicKeyB64), rawBody: ans, signatureB64: sign(privateKey, TS, ans), timestamp: TS, nowSeconds: NOW });
  assert.equal(vpA.ok, true);
  assert.equal(vpA.ok && vpA.event.eventType, "call.answered");
  const pAns = planStatusUpdate({ currentStatus: "ringing", incomingStatusRaw: "answered" });
  assert.equal(pAns?.nextStatus, "answered");
  assert.equal(pAns?.becameTerminal, false);

  // hangup (95s) — parser extracts duration, plan computes billable + cost
  const hup = callHangupBody(95);
  const parsed = parseTelnyxCallEvent(JSON.parse(hup));
  assert.equal(parsed.durationSeconds, 95);
  assert.equal(parsed.hangupCause, "normal_clearing");
  const pHup = planStatusUpdate({ currentStatus: "answered", incomingStatusRaw: "completed", durationSeconds: parsed.durationSeconds });
  assert.equal(pHup?.nextStatus, "completed");
  assert.equal(pHup?.becameTerminal, true);
  assert.equal(pHup?.billableSeconds, 120); // ceil(95/60)=2 min
  assert.deepEqual(pHup?.usageDelta, { answeredCalls: 1, missedCalls: 0, billableSeconds: 120, estimatedCostCents: 4 });
});

// ── status: idempotent — re-delivered terminal event does not double-count ──
test("synthetic status: duplicate hangup does not double-count usage", () => {
  const p = planStatusUpdate({ currentStatus: "completed", incomingStatusRaw: "completed", durationSeconds: 95 });
  assert.equal(p?.becameTerminal, false);
  assert.deepEqual(p?.usageDelta, { answeredCalls: 0, missedCalls: 0, billableSeconds: 0, estimatedCostCents: 0 });
});
