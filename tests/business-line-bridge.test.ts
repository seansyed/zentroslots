/**
 * Business Phone — OUTBOUND BRIDGE engine (P1.0). Pure-logic + synthetic-webhook
 * validation: NO real Telnyx, NO DB, NO server, NO network. Proves the exact
 * fail-closed behavior the route + webhook rely on:
 *   - entitlement / cap / concurrency / validation rejects
 *   - emergency / international / self-call / staff-loop rejects
 *   - a valid bridge decision + its TeXML (business number as caller ID only)
 *   - the originate client makes NO network call when the flag is OFF / unconfigured
 *   - a synthetic SIGNED bridge webhook produces the expected customer-leg <Dial>
 *   - status correlation does not double-count a two-leg bridged call
 *
 * Run: `npx tsx --test tests/business-line-bridge.test.ts`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";

import {
  decideOutboundBridge,
  resolveStaffBridge,
  bridgeRejectToHttp,
  texmlBridgeDial,
  resolveBridgeTarget,
  signBridgeToken,
  verifyBridgeToken,
  normalizeCallPurpose,
  callLogStatusForBridge,
  maskPhoneNumber,
  type OutboundBridgeContext,
} from "../lib/business-line-bridge";
import { canOriginate, originateBridgeCall, buildOriginatePayload } from "../lib/telnyx-api";
import { verifyAndParseInbound, planStatusUpdate } from "../lib/business-line-forwarding";
import { summarizeWebhookRequest, type BusinessLineConfig } from "../lib/telnyx-business-line";
import { readAddonActiveFlag } from "../lib/business-line-view";
import { getPlan, meetsPlan } from "../lib/plans";

// ── fixtures ───────────────────────────────────────────────────────
const BUSINESS = "+14155550100";
const STAFF = "+16475550123"; // tenant forwarding number (leg 1)
const CUSTOMER = "+12025550182"; // destination (leg 2)
const SECRET = "sk_test_secret";

const validCtx: OutboundBridgeContext = {
  businessNumber: BUSINESS,
  ownedNumbers: [BUSINESS],
  settingsEnabled: true,
  entitlementActive: true,
  // staff has their own bridge phone (P1.1)
  staffRowExists: true,
  staffEnabled: true,
  staffCanPlaceCalls: true,
  staffBridgeNumber: STAFF,
  tenantFallbackNumber: null,
  destinationRaw: CUSTOMER,
  minutesUsed: 0,
  monthlyMinuteCap: 200,
  activeOutboundCalls: 0,
  maxConcurrentCalls: 3,
};

function ctx(over: Partial<OutboundBridgeContext>): OutboundBridgeContext {
  return { ...validCtx, ...over };
}
function config(over: Partial<BusinessLineConfig> = {}): BusinessLineConfig {
  return {
    enabled: true,
    publicKey: "pk",
    apiKey: SECRET,
    texmlAppId: "app-123",
    replayToleranceSeconds: 300,
    ...over,
  };
}

// ── valid decision ─────────────────────────────────────────────────
test("valid context → bridge decision with business number as caller ID (staff phone)", () => {
  const d = decideOutboundBridge(validCtx);
  assert.deepEqual(d, {
    action: "bridge",
    customerNumber: CUSTOMER,
    staffNumber: STAFF,
    staffSource: "staff", // the staff's own bridge phone was used
    callerId: BUSINESS, // never the staff or customer number
  });
});

// ── entitlement / state rejects ────────────────────────────────────
test("entitlement inactive → reject no_entitlement (HTTP 402)", () => {
  const d = decideOutboundBridge(ctx({ entitlementActive: false }));
  assert.deepEqual(d, { action: "reject", reason: "no_entitlement" });
  assert.equal(bridgeRejectToHttp("no_entitlement").status, 402);
});

test("line disabled → reject line_disabled (HTTP 409)", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ settingsEnabled: false })), {
    action: "reject",
    reason: "line_disabled",
  });
  assert.equal(bridgeRejectToHttp("line_disabled").status, 409);
});

test("no provisioned business number → reject no_business_number", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ businessNumber: null })), {
    action: "reject",
    reason: "no_business_number",
  });
});

// ── cost-control rejects ───────────────────────────────────────────
test("over monthly cap → reject over_cap (HTTP 409)", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ minutesUsed: 200, monthlyMinuteCap: 200 })), {
    action: "reject",
    reason: "over_cap",
  });
  assert.equal(bridgeRejectToHttp("over_cap").status, 409);
});

test("at concurrency ceiling → reject concurrency_limit (HTTP 429)", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ activeOutboundCalls: 3, maxConcurrentCalls: 3 })), {
    action: "reject",
    reason: "concurrency_limit",
  });
  assert.equal(bridgeRejectToHttp("concurrency_limit").status, 429);
});

// ── destination validation rejects ─────────────────────────────────
test("international destination → reject international (HTTP 400)", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ destinationRaw: "+447911123456" })), {
    action: "reject",
    reason: "international",
  });
  assert.equal(bridgeRejectToHttp("international").status, 400);
});

test("emergency / N11 destination → reject emergency", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ destinationRaw: "911" })), {
    action: "reject",
    reason: "emergency",
  });
  assert.deepEqual(decideOutboundBridge(ctx({ destinationRaw: "411" })), {
    action: "reject",
    reason: "emergency",
  });
  assert.deepEqual(decideOutboundBridge(ctx({ destinationRaw: "1-911" })), {
    action: "reject",
    reason: "emergency",
  });
});

test("malformed US destination → reject invalid_destination", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ destinationRaw: "+1555" })), {
    action: "reject",
    reason: "invalid_destination",
  });
});

test("empty destination → reject no_destination", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ destinationRaw: "   " })), {
    action: "reject",
    reason: "no_destination",
  });
});

// ── loop / self-call rejects ───────────────────────────────────────
test("calling the business number itself → reject self_call", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ destinationRaw: BUSINESS })), {
    action: "reject",
    reason: "self_call",
  });
});

test("calling any owned number → reject self_call", () => {
  const other = "+14155550199";
  assert.deepEqual(
    decideOutboundBridge(ctx({ ownedNumbers: [BUSINESS, other], destinationRaw: other })),
    { action: "reject", reason: "self_call" },
  );
});

test("calling the staff forwarding number → reject staff_loop", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ destinationRaw: STAFF })), {
    action: "reject",
    reason: "staff_loop",
  });
});

// ── staff-leg resolution (P1.1) ────────────────────────────────────
test("no staff phone AND no tenant fallback → reject setup_required (HTTP 409)", () => {
  assert.deepEqual(
    decideOutboundBridge(ctx({ staffRowExists: false, staffBridgeNumber: null, tenantFallbackNumber: null })),
    { action: "reject", reason: "setup_required" },
  );
  assert.equal(bridgeRejectToHttp("setup_required").status, 409);
});

test("malformed staff number → reject invalid_staff_number", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ staffBridgeNumber: "+1555" })), {
    action: "reject",
    reason: "invalid_staff_number",
  });
});

test("no staff row → falls back to the tenant forwarding number", () => {
  const d = decideOutboundBridge(
    ctx({ staffRowExists: false, staffBridgeNumber: null, tenantFallbackNumber: STAFF }),
  );
  assert.deepEqual(d, {
    action: "bridge",
    customerNumber: CUSTOMER,
    staffNumber: STAFF,
    staffSource: "tenant", // tenant fallback (pilot compatibility)
    callerId: BUSINESS,
  });
});

test("staff row enabled+can-place but no number set → uses tenant fallback", () => {
  const d = decideOutboundBridge(ctx({ staffBridgeNumber: null, tenantFallbackNumber: STAFF }));
  assert.equal(d.action === "bridge" && d.staffSource, "tenant");
});

test("disabled staff cannot place calls → reject staff_disabled (HTTP 403)", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ staffEnabled: false })), {
    action: "reject",
    reason: "staff_disabled",
  });
  // even with a tenant fallback available, an explicit disabled row never falls back
  assert.deepEqual(decideOutboundBridge(ctx({ staffEnabled: false, tenantFallbackNumber: STAFF })), {
    action: "reject",
    reason: "staff_disabled",
  });
  assert.equal(bridgeRejectToHttp("staff_disabled").status, 403);
});

test("reject copy: setup_required + staff_disabled (P1.2.1 polish)", () => {
  const setup = bridgeRejectToHttp("setup_required");
  assert.equal(setup.status, 409);
  assert.match(setup.message, /Set your calling phone number first\. ZentroMeet will call you there/);
  const disabled = bridgeRejectToHttp("staff_disabled");
  assert.match(disabled.message, /do not have permission to place Business Phone calls/i);
});

test("staff with can_place_calls=false → reject staff_disabled", () => {
  assert.deepEqual(decideOutboundBridge(ctx({ staffCanPlaceCalls: false })), {
    action: "reject",
    reason: "staff_disabled",
  });
});

test("resolveStaffBridge resolution order", () => {
  // staff number wins
  assert.deepEqual(
    resolveStaffBridge({ staffRowExists: true, staffEnabled: true, staffCanPlaceCalls: true, staffBridgeNumber: STAFF, tenantFallbackNumber: "+15125550111" }),
    { kind: "ok", number: STAFF, source: "staff" },
  );
  // fallback when staff has no number
  assert.deepEqual(
    resolveStaffBridge({ staffRowExists: true, staffEnabled: true, staffCanPlaceCalls: true, staffBridgeNumber: null, tenantFallbackNumber: STAFF }),
    { kind: "ok", number: STAFF, source: "tenant" },
  );
  // no row at all → tenant fallback
  assert.deepEqual(
    resolveStaffBridge({ staffRowExists: false, staffEnabled: false, staffCanPlaceCalls: false, staffBridgeNumber: null, tenantFallbackNumber: STAFF }),
    { kind: "ok", number: STAFF, source: "tenant" },
  );
  // disabled row never falls back
  assert.deepEqual(
    resolveStaffBridge({ staffRowExists: true, staffEnabled: false, staffCanPlaceCalls: true, staffBridgeNumber: STAFF, tenantFallbackNumber: STAFF }),
    { kind: "disabled" },
  );
  // nothing configured
  assert.deepEqual(
    resolveStaffBridge({ staffRowExists: false, staffEnabled: false, staffCanPlaceCalls: false, staffBridgeNumber: null, tenantFallbackNumber: null }),
    { kind: "setup_required" },
  );
});

test("maskPhoneNumber reveals only the last 4 digits", () => {
  assert.equal(maskPhoneNumber("+14155550182"), "••• ••• 0182");
  assert.equal(maskPhoneNumber(null), null);
  assert.equal(maskPhoneNumber(""), null);
});

// ── visibility / entitlement composition (mirrors isBusinessPhoneEntitled) ──
// The Phone module is visible/usable ONLY when BOTH gates pass: Pro+ plan AND
// the active add-on flag. This is the exact rule GET /api/auth/me surfaces.
// canUseBusinessLine(plan) == meetsPlan(plan.id, "pro"); use the pure primitive
// directly so the test doesn't drag in the DB-backed capabilities/auth module.
function entitled(plan: string, metadata: unknown): boolean {
  return meetsPlan(getPlan(plan).id, "pro") && readAddonActiveFlag(metadata);
}
test("visibility: false unless subscribed (Pro+) AND add-on active", () => {
  assert.equal(entitled("free", { entitlementActive: true }), false); // plan too low
  assert.equal(entitled("pro", {}), false); // add-on not active
  assert.equal(entitled("pro", { entitlementActive: false }), false);
  assert.equal(entitled("pro", null), false);
  assert.equal(entitled("pro", { entitlementActive: true }), true); // both gates pass
  assert.equal(entitled("enterprise", { entitlementActive: true }), true);
});

// ── customer-leg TeXML ─────────────────────────────────────────────
test("texmlBridgeDial presents the business number, dials the customer, leaks no other number", () => {
  const xml = texmlBridgeDial({ customerNumber: CUSTOMER, callerId: BUSINESS });
  assert.match(xml, /<Dial /);
  assert.match(xml, /callerId="\+14155550100"/); // business number
  assert.match(xml, /<Number>\+12025550182<\/Number>/); // customer
  assert.match(xml, /timeLimit="3600"/);
  assert.match(xml, /timeout="30"/);
  assert.doesNotMatch(xml, new RegExp(STAFF.replace("+", "\\+"))); // staff never in response
});

// ── originate client: NO network when flag OFF / unconfigured ───────
test("canOriginate is false unless flag ON + apiKey + texmlAppId", () => {
  assert.equal(canOriginate(config({ enabled: false })), false);
  assert.equal(canOriginate(config({ apiKey: null })), false);
  assert.equal(canOriginate(config({ texmlAppId: null })), false);
  assert.equal(canOriginate(config()), true);
});

test("originateBridgeCall short-circuits (no fetch) when flag OFF", async () => {
  const r = await originateBridgeCall({
    config: config({ enabled: false }),
    to: STAFF,
    from: BUSINESS,
    bridgeUrl: "https://example.invalid/should-never-be-fetched",
  });
  assert.deepEqual(r, { ok: false, reason: "disabled" });
});

test("originateBridgeCall short-circuits (no fetch) when unconfigured", async () => {
  const r = await originateBridgeCall({
    config: config({ apiKey: null }),
    to: STAFF,
    from: BUSINESS,
    bridgeUrl: "https://example.invalid/should-never-be-fetched",
  });
  assert.deepEqual(r, { ok: false, reason: "unconfigured" });
});

// ── P1.x: originate payload no longer sets a per-call StatusCallback ──
test("buildOriginatePayload omits StatusCallback — outbound status uses the app-level callback", () => {
  const p = buildOriginatePayload({ to: STAFF, from: BUSINESS, bridgeUrl: "https://app.test/bridge?to=x", ringTimeoutSeconds: 30 });
  assert.equal(p.To, STAFF);
  assert.equal(p.From, BUSINESS);
  assert.equal(p.Url, "https://app.test/bridge?to=x");
  assert.equal(p.UrlMethod, "POST");
  assert.equal(p.Timeout, 30);
  assert.equal("StatusCallback" in p, false); // the fix: no per-call status callback
  assert.equal("StatusCallbackMethod" in p, false);
});

// ── P1.x: dark webhook diagnostic is secrets-free ──
test("summarizeWebhookRequest exposes only safe metadata (no secrets/body)", () => {
  const d = summarizeWebhookRequest({
    route: "voice/status",
    signature: "RAWSIG_must_not_leak",
    timestamp: "1700000000",
    bodyLength: 512,
    result: "bad_signature",
  });
  assert.deepEqual(Object.keys(d).sort(), ["bodyLength", "hasSignature", "hasTimestamp", "result", "route"]);
  assert.equal(d.hasSignature, true);
  assert.equal(d.hasTimestamp, true);
  assert.equal(d.bodyLength, 512);
  assert.equal(d.result, "bad_signature");
  const json = JSON.stringify(d);
  assert.doesNotMatch(json, /RAWSIG_must_not_leak/); // raw signature never included
  assert.doesNotMatch(json, /1700000000/); // raw timestamp value never included
});

test("summarizeWebhookRequest reports missing headers as false", () => {
  const d = summarizeWebhookRequest({ route: "voice/status", signature: null, timestamp: null, bodyLength: 0, result: "missing_headers" });
  assert.equal(d.hasSignature, false);
  assert.equal(d.hasTimestamp, false);
});

// ── HMAC bridge token (URL-param integrity) ────────────────────────
test("bridge token verifies for the exact (to,cid) and fails on tamper", () => {
  const token = signBridgeToken(SECRET, CUSTOMER, BUSINESS);
  assert.equal(verifyBridgeToken(SECRET, CUSTOMER, BUSINESS, token), true);
  assert.equal(verifyBridgeToken(SECRET, "+19998887777", BUSINESS, token), false); // repointed customer
  assert.equal(verifyBridgeToken(SECRET, CUSTOMER, "+19998887777", token), false); // changed caller ID
  assert.equal(verifyBridgeToken("other_secret", CUSTOMER, BUSINESS, token), false); // wrong secret
  assert.equal(verifyBridgeToken(SECRET, CUSTOMER, BUSINESS, null), false); // missing token
});

// ── synthetic SIGNED bridge webhook → expected TeXML ───────────────
function makeKeypair(): { privateKey: KeyObject; publicKeyB64: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return { privateKey, publicKeyB64: spki.subarray(spki.length - 32).toString("base64") };
}
function sign(pk: KeyObject, ts: string, body: string): string {
  return nodeSign(null, Buffer.from(`${ts}|${body}`, "utf8"), pk).toString("base64");
}

test("synthetic signed bridge webhook → customer-leg <Dial> with business caller ID", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const ts = "1700000000";
  // The staff-leg-answered TeXML body Telnyx posts (form-encoded, signed).
  const body = new URLSearchParams({
    CallSid: "CA-bridge-1",
    CallStatus: "in-progress",
    From: BUSINESS,
    To: STAFF,
    AccountSid: "acc",
  }).toString();

  // 1) body authenticity (flag + Ed25519)
  const vp = verifyAndParseInbound({
    config: config({ publicKey: publicKeyB64 }),
    rawBody: body,
    signatureB64: sign(privateKey, ts, body),
    timestamp: ts,
    nowSeconds: 1700000000,
  });
  assert.equal(vp.ok, true);

  // 2) URL routing params: integrity token + re-validation
  const token = signBridgeToken(SECRET, CUSTOMER, BUSINESS);
  assert.equal(verifyBridgeToken(SECRET, CUSTOMER, BUSINESS, token), true);
  const target = resolveBridgeTarget({ to: CUSTOMER, cid: BUSINESS });
  assert.equal(target.ok, true);

  // 3) the resulting TeXML
  const xml = target.ok ? texmlBridgeDial({ customerNumber: target.customerNumber, callerId: target.callerId }) : "";
  assert.match(xml, /callerId="\+14155550100"/);
  assert.match(xml, /<Number>\+12025550182<\/Number>/);
});

test("bridge webhook declines a tampered/forged signature (no Dial)", () => {
  const { privateKey, publicKeyB64 } = makeKeypair();
  const ts = "1700000000";
  const body = new URLSearchParams({ CallSid: "CA-1", From: BUSINESS, To: STAFF }).toString();
  const sig = sign(privateKey, ts, body);
  const vp = verifyAndParseInbound({
    config: config({ publicKey: publicKeyB64 }),
    rawBody: body.replace(STAFF.slice(1), "16475550999"), // tamper after signing
    signatureB64: sig,
    timestamp: ts,
    nowSeconds: 1700000000,
  });
  assert.deepEqual(vp, { ok: false, reason: "bad_signature" });
});

test("resolveBridgeTarget re-validates fail-closed (emergency / intl / missing)", () => {
  assert.equal(resolveBridgeTarget({ to: "911", cid: BUSINESS }).ok, false);
  assert.equal(resolveBridgeTarget({ to: "+447911123456", cid: BUSINESS }).ok, false);
  assert.equal(resolveBridgeTarget({ to: CUSTOMER, cid: null }).ok, false);
  assert.equal(resolveBridgeTarget({ to: CUSTOMER, cid: BUSINESS }).ok, true);
});

// ── status correlation: a two-leg bridge counts ONCE ───────────────
test("outbound bridge status: answered→completed counts once; duplicate terminal is a no-op", () => {
  // staff/customer answered → completed (95s conversation)
  const first = planStatusUpdate({ currentStatus: "answered", incomingStatusRaw: "completed", durationSeconds: 95 });
  assert.equal(first?.nextStatus, "completed");
  assert.equal(first?.becameTerminal, true);
  assert.deepEqual(first?.usageDelta, { answeredCalls: 1, missedCalls: 0, billableSeconds: 120, estimatedCostCents: 4 });

  // a re-delivered terminal event (e.g. the other leg's hangup) must NOT re-bill
  const dup = planStatusUpdate({ currentStatus: "completed", incomingStatusRaw: "completed", durationSeconds: 95 });
  assert.equal(dup?.becameTerminal, false);
  assert.deepEqual(dup?.usageDelta, { answeredCalls: 0, missedCalls: 0, billableSeconds: 0, estimatedCostCents: 0 });
});

test("outbound bridge status: staff never answers → missed, no billable", () => {
  const p = planStatusUpdate({ currentStatus: "ringing", incomingStatusRaw: "no-answer" });
  assert.equal(p?.nextStatus, "missed");
  assert.deepEqual(p?.usageDelta, { answeredCalls: 0, missedCalls: 1, billableSeconds: 0, estimatedCostCents: 0 });
});

// ── small helpers ──────────────────────────────────────────────────
test("normalizeCallPurpose accepts the closed set, rejects anything else", () => {
  assert.equal(normalizeCallPurpose("new_call"), "new_call");
  assert.equal(normalizeCallPurpose("callback_missed"), "callback_missed");
  assert.equal(normalizeCallPurpose("customer_call"), "customer_call");
  assert.equal(normalizeCallPurpose("sms"), null);
  assert.equal(normalizeCallPurpose(null), null);
});

test("callLogStatusForBridge: bridge→ringing, reject→rejected", () => {
  assert.equal(
    callLogStatusForBridge({ action: "bridge", customerNumber: CUSTOMER, staffNumber: STAFF, staffSource: "staff", callerId: BUSINESS }),
    "ringing",
  );
  assert.equal(callLogStatusForBridge({ action: "reject", reason: "over_cap" }), "rejected");
});
