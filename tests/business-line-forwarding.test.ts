/**
 * Business Line call-forwarding decision + status logic (increment 4). Pure
 * tests — no DB, no network, no real Telnyx. Covers: the forwarding decision
 * for every reject reason and the valid dial (business-number caller ID); the
 * TeXML for each decision; flag/signature gating of inbound events; and
 * monotonic status transitions + usage-counter math.
 *
 * Run: `npx tsx --test tests/business-line-forwarding.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import {
  decideForwarding,
  callLogStatusForDecision,
  texmlForDecision,
  verifyAndParseInbound,
  nextCallStatus,
  isTerminalCallStatus,
  planStatusUpdate,
  resolveAnsweredAt,
  MAX_CALL_SECONDS,
  type ForwardingContext,
} from "../lib/business-line-forwarding";
import type { BusinessLineConfig } from "../lib/telnyx-business-line";

// ── Ed25519 vector helpers (local; no real Telnyx key) ─────────────
function makeKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyB64: spki.subarray(spki.length - 32).toString("base64") };
}
function signTelnyx(privateKey: KeyObject, ts: string, body: string): string {
  return nodeSign(null, Buffer.from(`${ts}|${body}`, "utf8"), privateKey).toString("base64");
}
function cfg(over: Partial<BusinessLineConfig> = {}): BusinessLineConfig {
  return { enabled: true, publicKey: "x", apiKey: null, replayToleranceSeconds: 300, ...over };
}

// ── forwarding decision ────────────────────────────────────────────
const validCtx: ForwardingContext = {
  tenantMatched: true,
  businessNumber: "+14155550100",
  ownedNumbers: ["+14155550100"],
  settingsEnabled: true,
  entitlementActive: true,
  forwardingNumber: "(647) 555-0123",
  minutesUsed: 10,
  monthlyMinuteCap: 200,
};

test("decideForwarding: valid context → dial with business-number caller ID", () => {
  assert.deepEqual(decideForwarding(validCtx), {
    action: "dial",
    forwardingNumber: "+16475550123", // normalized
    callerId: "+14155550100", // the business number, NOT the caller
  });
  assert.equal(callLogStatusForDecision(decideForwarding(validCtx)), "ringing");
});

test("decideForwarding: every precondition failure → typed reject", () => {
  const cases: Array<[Partial<ForwardingContext>, string]> = [
    [{ tenantMatched: false }, "no_tenant"],
    [{ businessNumber: null }, "no_tenant"],
    [{ settingsEnabled: false }, "line_disabled"],
    [{ entitlementActive: false }, "no_entitlement"],
    [{ forwardingNumber: null }, "no_forwarding_number"],
    [{ forwardingNumber: "   " }, "no_forwarding_number"],
    [{ forwardingNumber: "+447911123456" }, "invalid_forwarding_number"], // UK
    [{ forwardingNumber: "911" }, "invalid_forwarding_number"], // emergency rejected as invalid target
    [{ forwardingNumber: "+14155550100" }, "forwarding_loop"], // own number
    [{ minutesUsed: 200, monthlyMinuteCap: 200 }, "over_cap"],
    [{ minutesUsed: 201, monthlyMinuteCap: 200 }, "over_cap"],
  ];
  for (const [over, reason] of cases) {
    const d = decideForwarding({ ...validCtx, ...over });
    assert.equal(d.action, "reject", `${reason}: expected reject`);
    assert.equal(d.action === "reject" && d.reason, reason);
  }
});

test("callLogStatusForDecision maps no_forwarding vs other rejects", () => {
  assert.equal(callLogStatusForDecision({ action: "reject", reason: "no_forwarding_number" }), "no_forwarding");
  assert.equal(callLogStatusForDecision({ action: "reject", reason: "line_disabled" }), "rejected");
  assert.equal(callLogStatusForDecision({ action: "reject", reason: "over_cap" }), "rejected");
});

test("texmlForDecision: Dial only for the valid case, business number as callerId", () => {
  const dial = texmlForDecision(decideForwarding(validCtx), { statusCallbackUrl: "https://a.test/s", timeLimitSeconds: MAX_CALL_SECONDS });
  assert.match(dial, /<Dial /);
  assert.match(dial, /callerId="\+14155550100"/);
  assert.match(dial, /<Number>\+16475550123<\/Number>/);
  assert.match(dial, /timeLimit="3600"/);
  assert.match(dial, /timeout="30"/); // explicit ring timeout
  // exact element shape (callerId, timeLimit, timeout — no action)
  assert.match(dial, /<Dial callerId="\+14155550100" timeLimit="3600" timeout="30"><Number>\+16475550123<\/Number><\/Dial>/);

  for (const reason of ["line_disabled", "no_entitlement", "over_cap", "forwarding_loop"] as const) {
    const xml = texmlForDecision({ action: "reject", reason });
    assert.match(xml, /<Reject\/>/);
    assert.doesNotMatch(xml, /<Dial|\+\d/); // no dial, no number leaked
  }
  // no_forwarding also a bare reject with no number
  assert.doesNotMatch(texmlForDecision({ action: "reject", reason: "no_forwarding_number" }), /<Dial|\+\d/);
});

// ── inbound gate (flag + signature) ────────────────────────────────
test("verifyAndParseInbound: flag OFF → disabled (no forwarding possible)", () => {
  const { publicKeyB64 } = makeKeypair();
  assert.deepEqual(
    verifyAndParseInbound({ config: cfg({ enabled: false, publicKey: publicKeyB64 }), rawBody: "{}", signatureB64: "s", timestamp: "1" }),
    { ok: false, reason: "disabled" },
  );
});

test("verifyAndParseInbound: ON + valid signature → parsed event; tamper/no-key → bad_signature", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = '{"data":{"id":"evt1","event_type":"call.initiated","payload":{"to":"+14155550100","from":"+19998887777","call_session_id":"sess1"}}}';
  const ts = "1700000000";
  const sig = signTelnyx(privateKey, ts, body);

  const ok = verifyAndParseInbound({ config: cfg({ publicKey: publicKeyB64 }), rawBody: body, signatureB64: sig, timestamp: ts, nowSeconds: 1700000000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.event.to, "+14155550100");
  assert.equal(ok.ok && ok.event.callSessionId, "sess1");

  // tampered body
  assert.deepEqual(
    verifyAndParseInbound({ config: cfg({ publicKey: publicKeyB64 }), rawBody: "TAMPERED", signatureB64: sig, timestamp: ts, nowSeconds: 1700000000 }),
    { ok: false, reason: "bad_signature" },
  );
  // enabled but no public key configured → fail closed
  assert.deepEqual(
    verifyAndParseInbound({ config: cfg({ publicKey: null }), rawBody: body, signatureB64: sig, timestamp: ts, nowSeconds: 1700000000 }),
    { ok: false, reason: "bad_signature" },
  );
});

test("end-to-end (pure): signed inbound + valid context → Dial TeXML", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const body = '{"data":{"id":"e","event_type":"call.initiated","payload":{"to":"+14155550100","from":"+19998887777","call_session_id":"s"}}}';
  const ts = "1700000000";
  const vp = verifyAndParseInbound({
    config: cfg({ publicKey: publicKeyB64 }),
    rawBody: body,
    signatureB64: signTelnyx(privateKey, ts, body),
    timestamp: ts,
    nowSeconds: 1700000000,
  });
  assert.equal(vp.ok, true);
  const decision = decideForwarding(validCtx); // tenant context the route would resolve
  assert.match(texmlForDecision(decision), /<Dial /);
});

// ── monotonic status transitions ───────────────────────────────────
test("nextCallStatus never regresses; terminal is sticky", () => {
  assert.equal(nextCallStatus(null, "ringing"), "ringing");
  assert.equal(nextCallStatus("ringing", "answered"), "answered");
  assert.equal(nextCallStatus("answered", "completed"), "completed");
  assert.equal(nextCallStatus("completed", "ringing"), "completed"); // no regress
  assert.equal(nextCallStatus("answered", "ringing"), "answered"); // no regress
  assert.equal(nextCallStatus("missed", "completed"), "missed"); // terminal sticky
  assert.equal(isTerminalCallStatus("completed"), true);
  assert.equal(isTerminalCallStatus("ringing"), false);
});

// ── status plan + usage counters ───────────────────────────────────
test("planStatusUpdate: ringing→answered has no usage delta", () => {
  const p = planStatusUpdate({ currentStatus: "ringing", incomingStatusRaw: "answered" });
  assert.equal(p?.nextStatus, "answered");
  assert.equal(p?.becameTerminal, false);
  assert.deepEqual(p?.usageDelta, { answeredCalls: 0, missedCalls: 0, billableSeconds: 0, estimatedCostCents: 0 });
});

test("planStatusUpdate: answered→completed counts answered + billable minutes", () => {
  const p = planStatusUpdate({ currentStatus: "answered", incomingStatusRaw: "completed", durationSeconds: 90 });
  assert.equal(p?.nextStatus, "completed");
  assert.equal(p?.becameTerminal, true);
  assert.equal(p?.durationSeconds, 90);
  assert.equal(p?.billableSeconds, 120); // ceil(90/60)=2 min → 120s
  assert.deepEqual(p?.usageDelta, { answeredCalls: 1, missedCalls: 0, billableSeconds: 120, estimatedCostCents: 4 });
});

test("planStatusUpdate: ringing→missed counts a missed call, no billable", () => {
  const p = planStatusUpdate({ currentStatus: "ringing", incomingStatusRaw: "missed" });
  assert.equal(p?.nextStatus, "missed");
  assert.equal(p?.becameTerminal, true);
  assert.deepEqual(p?.usageDelta, { answeredCalls: 0, missedCalls: 1, billableSeconds: 0, estimatedCostCents: 0 });
});

test("planStatusUpdate: duplicate terminal event does NOT double-count", () => {
  const p = planStatusUpdate({ currentStatus: "completed", incomingStatusRaw: "completed", durationSeconds: 90 });
  assert.equal(p?.nextStatus, "completed");
  assert.equal(p?.becameTerminal, false); // already terminal → no counter
  assert.deepEqual(p?.usageDelta, { answeredCalls: 0, missedCalls: 0, billableSeconds: 0, estimatedCostCents: 0 });
});

test("resolveAnsweredAt: back-stamps answered_at on completed, keeps/handles others", () => {
  const started = new Date("2026-06-27T05:17:10Z");
  const now = new Date("2026-06-27T05:17:46Z");
  const existing = new Date("2026-06-27T05:17:15Z");

  // already set → unchanged
  assert.equal(
    resolveAnsweredAt({ currentAnsweredAt: existing, nextStatus: "completed", becameTerminal: true, startedAt: started, now })?.toISOString(),
    existing.toISOString(),
  );
  // answered transition → now
  assert.equal(
    resolveAnsweredAt({ currentAnsweredAt: null, nextStatus: "answered", becameTerminal: false, startedAt: started, now })?.toISOString(),
    now.toISOString(),
  );
  // completed terminal w/ null answered_at → back-stamp from startedAt (the fix)
  assert.equal(
    resolveAnsweredAt({ currentAnsweredAt: null, nextStatus: "completed", becameTerminal: true, startedAt: started, now })?.toISOString(),
    started.toISOString(),
  );
  // completed terminal but no startedAt → fall back to now
  assert.equal(
    resolveAnsweredAt({ currentAnsweredAt: null, nextStatus: "completed", becameTerminal: true, startedAt: null, now })?.toISOString(),
    now.toISOString(),
  );
  // never answered (missed/failed) → null
  assert.equal(resolveAnsweredAt({ currentAnsweredAt: null, nextStatus: "missed", becameTerminal: true, startedAt: started, now }), null);
  assert.equal(resolveAnsweredAt({ currentAnsweredAt: null, nextStatus: "failed", becameTerminal: true, startedAt: started, now }), null);
});

test("planStatusUpdate: completed cannot regress to ringing; unknown status → null", () => {
  const p = planStatusUpdate({ currentStatus: "completed", incomingStatusRaw: "ringing" });
  assert.equal(p?.nextStatus, "completed");
  assert.equal(p?.becameTerminal, false);
  assert.equal(planStatusUpdate({ currentStatus: "ringing", incomingStatusRaw: "teleported" }), null);
});
