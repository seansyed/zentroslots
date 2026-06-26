/**
 * Telnyx Business Line plumbing (increment 2 — skeleton, flag OFF). Pins:
 * feature-flag defaults, config resolution, TeXML builders (escaping, no leaked
 * numbers in reject/disabled), caller-ID policy, the status-callback URL, the
 * Ed25519 signature verifier (valid / tampered / wrong-key / missing-headers /
 * bad + stale timestamp), and the defensive event parser.
 *
 * Ed25519 vectors are GENERATED LOCALLY with node:crypto — no network, no real
 * Telnyx key, no new dependency. Run: `npx tsx --test tests/telnyx-business-line.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import {
  readBusinessLineConfig,
  resolveBusinessLineConfig,
  verifyTelnyxSignature,
  escapeXml,
  texmlReject,
  texmlDisabled,
  texmlNoForwarding,
  texmlDial,
  selectCallerId,
  buildStatusCallbackUrl,
  parseTelnyxCallEvent,
} from "../lib/telnyx-business-line";

// ── local Ed25519 test-vector helpers ──────────────────────────────
function makeKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // Ed25519 SPKI = 12-byte header + 32-byte raw key; Telnyx publishes the raw
  // key as base64.
  const rawPub = spki.subarray(spki.length - 32);
  return { privateKey, publicKeyB64: rawPub.toString("base64") };
}
function signTelnyx(privateKey: KeyObject, timestamp: string, body: string): string {
  return nodeSign(null, Buffer.from(`${timestamp}|${body}`, "utf8"), privateKey).toString("base64");
}

// ── feature flag defaults OFF ──────────────────────────────────────
test("feature flag defaults OFF; resolve reports disabled", () => {
  assert.equal(readBusinessLineConfig({}).enabled, false);
  assert.equal(readBusinessLineConfig({ TELNYX_BUSINESS_LINE_ENABLED: "false" }).enabled, false);
  assert.equal(readBusinessLineConfig({ TELNYX_BUSINESS_LINE_ENABLED: "1" }).enabled, false); // only "true"
  assert.equal(readBusinessLineConfig({ TELNYX_BUSINESS_LINE_ENABLED: "TRUE" }).enabled, true);
  assert.deepEqual(resolveBusinessLineConfig({}), { ok: false, reason: "disabled" });
});

test("when enabled, TELNYX_PUBLIC_KEY is required (API key is NOT)", () => {
  assert.deepEqual(resolveBusinessLineConfig({ TELNYX_BUSINESS_LINE_ENABLED: "true" }), {
    ok: false,
    reason: "missing_public_key",
  });
  const r = resolveBusinessLineConfig({
    TELNYX_BUSINESS_LINE_ENABLED: "true",
    TELNYX_PUBLIC_KEY: "abc",
  });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.config.apiKey, null); // api key absent is fine in this increment
});

// ── TeXML builders ─────────────────────────────────────────────────
test("reject / disabled / no-forwarding are safe and carry NO phone number", () => {
  const expected = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';
  for (const xml of [texmlReject(), texmlDisabled(), texmlNoForwarding()]) {
    // Exact match proves the body is a bare reject — no <Dial>, no <Number>,
    // and no phone number anywhere (the only digits are in the XML decl).
    assert.equal(xml, expected);
    assert.doesNotMatch(xml, /<Dial|<Number/);
    // no E.164-shaped value (a "+" followed by digits) leaked
    assert.doesNotMatch(xml, /\+\d/);
  }
});

test("texmlDial escapes interpolated values and presents callerId + <Number>", () => {
  const xml = texmlDial({
    forwardingNumber: "+1415555<&>\"'0100",
    callerId: "+1<&>415",
    statusCallbackUrl: "https://x.test/cb?a=1&b=2",
    timeLimitSeconds: 600,
  });
  assert.match(xml, /<Dial /);
  assert.match(xml, /callerId="\+1&lt;&amp;&gt;415"/);
  assert.match(xml, /timeLimit="600"/);
  assert.match(xml, /action="https:\/\/x\.test\/cb\?a=1&amp;b=2"/);
  assert.match(xml, /<Number>\+1415555&lt;&amp;&gt;&quot;&apos;0100<\/Number>/);
  // raw special chars must not survive unescaped inside the document body
  assert.ok(!/[<>&"']0100/.test(xml.replace(/&(amp|lt|gt|quot|apos);/g, "")));
});

test("escapeXml handles all five entities", () => {
  assert.equal(escapeXml(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
});

test("MVP caller-ID policy returns the business number, ignoring the caller", () => {
  assert.equal(
    selectCallerId({ businessNumber: "+14155550100", callerNumber: "+19998887777" }),
    "+14155550100",
  );
});

test("buildStatusCallbackUrl appends the status path, trimming trailing slashes", () => {
  assert.equal(
    buildStatusCallbackUrl("https://app.zentromeet.com/"),
    "https://app.zentromeet.com/api/webhooks/telnyx/voice/status",
  );
  assert.equal(
    buildStatusCallbackUrl("https://app.zentromeet.com"),
    "https://app.zentromeet.com/api/webhooks/telnyx/voice/status",
  );
});

// ── Ed25519 signature verification ─────────────────────────────────
test("signature verification: valid signature passes", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = '{"data":{"event_type":"call.initiated","id":"evt_1"}}';
  const ts = "1700000000";
  const sig = signTelnyx(privateKey, ts, body);
  assert.deepEqual(
    verifyTelnyxSignature({
      payload: body,
      signatureB64: sig,
      timestamp: ts,
      publicKeyB64,
      nowSeconds: 1700000000,
    }),
    { ok: true },
  );
});

test("signature verification: tampered body and wrong key are rejected", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const ts = "1700000000";
  const sig = signTelnyx(privateKey, ts, "ORIGINAL");
  // tampered payload
  assert.deepEqual(
    verifyTelnyxSignature({ payload: "TAMPERED", signatureB64: sig, timestamp: ts, publicKeyB64, nowSeconds: 1700000000 }),
    { ok: false, reason: "invalid_signature" },
  );
  // signature from a different key
  const other = makeKeypair();
  assert.deepEqual(
    verifyTelnyxSignature({ payload: "ORIGINAL", signatureB64: sig, timestamp: ts, publicKeyB64: other.publicKeyB64, nowSeconds: 1700000000 }),
    { ok: false, reason: "invalid_signature" },
  );
});

test("signature verification: missing headers and bad timestamp", () => {
  const { publicKeyB64 } = makeKeypair();
  assert.deepEqual(
    verifyTelnyxSignature({ payload: "x", signatureB64: null, timestamp: "1700000000", publicKeyB64 }),
    { ok: false, reason: "missing_headers" },
  );
  assert.deepEqual(
    verifyTelnyxSignature({ payload: "x", signatureB64: "sig", timestamp: null, publicKeyB64 }),
    { ok: false, reason: "missing_headers" },
  );
  assert.deepEqual(
    verifyTelnyxSignature({ payload: "x", signatureB64: "sig", timestamp: "not-a-number", publicKeyB64 }),
    { ok: false, reason: "bad_timestamp" },
  );
});

test("signature verification: stale timestamp outside replay window is rejected", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const ts = "1700000000";
  const sig = signTelnyx(privateKey, ts, "BODY");
  // 301s skew > default 300s tolerance → stale (before any crypto)
  assert.deepEqual(
    verifyTelnyxSignature({ payload: "BODY", signatureB64: sig, timestamp: ts, publicKeyB64, nowSeconds: 1700000301 }),
    { ok: false, reason: "stale" },
  );
  // within tolerance still passes
  assert.deepEqual(
    verifyTelnyxSignature({ payload: "BODY", signatureB64: sig, timestamp: ts, publicKeyB64, nowSeconds: 1700000299 }),
    { ok: true },
  );
});

test("signature verification: malformed public key → config (never throws)", () => {
  const r = verifyTelnyxSignature({
    payload: "BODY",
    signatureB64: "AAAA",
    timestamp: "1700000000",
    publicKeyB64: "not-a-32-byte-key",
    nowSeconds: 1700000000,
  });
  assert.deepEqual(r, { ok: false, reason: "config" });
});

// ── event parser ───────────────────────────────────────────────────
test("parseTelnyxCallEvent extracts nested fields; garbage → nulls", () => {
  const body = {
    data: {
      id: "evt_abc",
      event_type: "call.hangup",
      payload: {
        call_session_id: "sess_1",
        call_control_id: "cc_1",
        call_leg_id: "leg_1",
        from: "+19998887777",
        to: { phone_number: "+14155550100" },
        hangup_cause: "normal_clearing",
        call_duration_secs: "47",
      },
    },
  };
  assert.deepEqual(parseTelnyxCallEvent(body), {
    eventId: "evt_abc",
    eventType: "call.hangup",
    callSessionId: "sess_1",
    callControlId: "cc_1",
    callLegId: "leg_1",
    from: "+19998887777",
    to: "+14155550100",
    hangupCause: "normal_clearing",
    durationSeconds: 47,
  });
  // defensive: empty / wrong-shaped input never throws, yields all-null
  for (const junk of [null, undefined, {}, { data: 5 }, "str"]) {
    const r = parseTelnyxCallEvent(junk as unknown);
    assert.equal(r.eventId, null);
    assert.equal(r.callSessionId, null);
    assert.equal(r.durationSeconds, null);
  }
});
