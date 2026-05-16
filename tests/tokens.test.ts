/**
 * Run: npm test
 * Uses Node's built-in test runner (no extra deps).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-must-be-long-enough-for-hmac-please";

import { signBookingToken, verifyBookingToken } from "../lib/tokens";

describe("booking tokens", () => {
  it("round-trips a cancel token", async () => {
    const t = await signBookingToken({
      bookingId: "b-1",
      tenantId: "t-1",
      kind: "cancel",
    });
    const v = await verifyBookingToken(t);
    assert.ok(v);
    assert.equal(v!.bookingId, "b-1");
    assert.equal(v!.tenantId, "t-1");
    assert.equal(v!.kind, "cancel");
  });

  it("rejects garbage", async () => {
    assert.equal(await verifyBookingToken("not-a-token"), null);
    assert.equal(await verifyBookingToken(""), null);
  });

  it("rejects a tampered token", async () => {
    const t = await signBookingToken({
      bookingId: "b-1",
      tenantId: "t-1",
      kind: "cancel",
    });
    const tampered = t.slice(0, -2) + "XX";
    assert.equal(await verifyBookingToken(tampered), null);
  });

  it("does not accept a session token (different purpose)", async () => {
    // SignJWT used by lib/auth omits the purpose claim. Forge one that
    // verifies cryptographically but lacks purpose: 'booking_action'.
    const { SignJWT } = await import("jose");
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const t = await new SignJWT({ sub: "u-1", role: "admin", email: "x@y.z", tenantId: "t-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .sign(secret);
    assert.equal(await verifyBookingToken(t), null);
  });
});
