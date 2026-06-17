/**
 * Run: npm test
 *
 * P0 — Error Handling Hardening. Two layers:
 *   (1) lib/auth.ts errorResponse — the central API serializer MUST NOT
 *       leak raw exception text (Node/TS/SQL/Buffer/Date/stack) to clients.
 *   (2) lib/clientErrors.ts — the UI helper that maps a failed response /
 *       thrown network error to friendly { title, message } copy.
 *
 * The regression these lock in: a raw Node TypeError
 *   "The \"string\" argument must be of type string ... Received an instance of Date"
 * reached the New Appointment UI verbatim because errorResponse echoed
 * err.message on 500 and the modal rendered data.error directly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { errorResponse, HttpError } from "../lib/auth";
import {
  friendlyError,
  friendlyMessage,
  friendlyThrown,
  GENERIC_ERROR,
  NETWORK_ERROR,
} from "../lib/clientErrors";

// The exact raw error that leaked in production.
const RAW_DATE_ERROR =
  'The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received an instance of Date';

async function readJson(res: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("errorResponse — never leaks raw exceptions on 500", () => {
  it("returns a generic message + code + incidentId for an unexpected Error", async () => {
    const res = errorResponse(new Error(RAW_DATE_ERROR));
    assert.equal(res.status, 500);
    const body = await readJson(res);
    assert.equal(body.code, "internal_error");
    assert.ok(typeof body.incidentId === "string" && (body.incidentId as string).length > 0);
    // The raw Node/Buffer/Date text must NOT appear anywhere in the body.
    const blob = JSON.stringify(body);
    assert.ok(!blob.includes("Received an instance of Date"), "leaked the raw Date error");
    assert.ok(!/Buffer|ArrayBuffer/.test(blob), "leaked Buffer/ArrayBuffer internals");
    assert.match(body.error as string, /something went wrong/i);
  });

  it("does not leak SQL / driver error text", async () => {
    const res = errorResponse(new Error('relation "bookings" does not exist'));
    const body = await readJson(res);
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(body).includes("bookings"), "leaked SQL relation text");
  });

  it("handles non-Error throws (string/object) without leaking", async () => {
    const res = errorResponse("kaboom at /var/secret/path");
    const body = await readJson(res);
    assert.equal(res.status, 500);
    assert.ok(!JSON.stringify(body).includes("secret"), "leaked thrown string");
    assert.equal(body.code, "internal_error");
  });

  it("each unexpected error gets a distinct incidentId (correlation)", async () => {
    const a = await readJson(errorResponse(new Error("x")));
    const b = await readJson(errorResponse(new Error("y")));
    assert.notEqual(a.incidentId, b.incidentId);
  });
});

describe("errorResponse — preserves intentional, safe messages", () => {
  it("HttpError surfaces its operator-authored message + status", async () => {
    const res = errorResponse(new HttpError(409, "Slot just taken — pick another"));
    assert.equal(res.status, 409);
    const body = await readJson(res);
    assert.equal(body.error, "Slot just taken — pick another");
    assert.equal(body.code, undefined); // not the internal envelope
  });

  it("ZodError maps to 400 Invalid input with field issues", async () => {
    const zodLike = { name: "ZodError", issues: [{ path: ["email"], message: "Required" }] };
    const res = errorResponse(zodLike);
    assert.equal(res.status, 400);
    const body = await readJson(res);
    assert.equal(body.error, "Invalid input");
    assert.ok(Array.isArray(body.issues));
  });
});

describe("clientErrors.friendlyError — maps responses to safe copy", () => {
  it("409 → time-slot-unavailable conflict copy", () => {
    const f = friendlyError(409, { error: "Staff has an overlapping booking" });
    assert.match(f.title, /unavailable|taken/i);
    assert.ok(f.message.length > 0);
  });

  it("500 / internal_error → generic copy, NEVER the server text", () => {
    const f = friendlyError(500, { error: RAW_DATE_ERROR, code: "internal_error" });
    assert.deepEqual(f, GENERIC_ERROR);
    assert.ok(!f.message.includes("Date"));
  });

  it("even if a 500 body carries raw text without the code, it is suppressed", () => {
    const f = friendlyError(500, { error: RAW_DATE_ERROR });
    assert.ok(!/Date|Buffer/.test(f.message));
    assert.equal(f.title, GENERIC_ERROR.title);
  });

  it("4xx with a safe server message shows that message", () => {
    const f = friendlyError(400, { error: "Email is required" });
    assert.equal(f.message, "Email is required");
  });

  it("suppresses an over-long 4xx 'message' (likely a raw dump)", () => {
    const long = "x".repeat(500);
    const f = friendlyError(400, { error: long });
    assert.notEqual(f.message, long);
  });

  it("genericMessage override is used for unexpected failures", () => {
    const f = friendlyError(500, { code: "internal_error" }, {
      genericMessage: "Something went wrong while creating the appointment. Please try again.",
    });
    assert.match(f.message, /creating the appointment/);
  });

  it("friendlyMessage returns just the string", () => {
    assert.equal(
      friendlyMessage(500, { code: "internal_error" }),
      GENERIC_ERROR.message,
    );
  });

  it("friendlyThrown → connection-problem copy (network failure)", () => {
    assert.deepEqual(friendlyThrown(), NETWORK_ERROR);
    assert.match(NETWORK_ERROR.title, /connection/i);
  });
});
