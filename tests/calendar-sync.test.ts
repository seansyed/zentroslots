/**
 * Unit tests for the pure parts of lib/calendar/google.ts.
 *
 * The orchestrator (sync.ts) touches DB + network and is exercised in
 * the production smoke phase. Here we cover error classification, which
 * is what decides whether we flip a connection to needs_reconnect.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyError,
  ConfigError,
  errorMessage,
} from "../lib/calendar/google";

describe("calendar: classifyError", () => {
  it("classifies ConfigError as 'config'", () => {
    assert.equal(classifyError(new ConfigError("missing env")), "config");
  });

  it("classifies 401 / 403 as 'auth'", () => {
    assert.equal(classifyError({ code: 401 }), "auth");
    assert.equal(classifyError({ code: 403 }), "auth");
    assert.equal(classifyError({ response: { status: 401 } }), "auth");
    assert.equal(classifyError({ status: 403 }), "auth");
  });

  it("classifies 404 / 410 as 'not_found'", () => {
    assert.equal(classifyError({ code: 404 }), "not_found");
    assert.equal(classifyError({ code: 410 }), "not_found");
    assert.equal(classifyError({ response: { status: 404 } }), "not_found");
  });

  it("classifies 429 as 'rate_limit'", () => {
    assert.equal(classifyError({ code: 429 }), "rate_limit");
  });

  it("classifies 5xx as 'transient'", () => {
    assert.equal(classifyError({ code: 500 }), "transient");
    assert.equal(classifyError({ code: 502 }), "transient");
    assert.equal(classifyError({ code: 503 }), "transient");
    assert.equal(classifyError({ response: { status: 504 } }), "transient");
  });

  it("classifies network errors as 'transient'", () => {
    assert.equal(classifyError({ code: "ECONNRESET" }), "transient");
    assert.equal(classifyError({ code: "ETIMEDOUT" }), "transient");
    assert.equal(classifyError({ code: "ECONNREFUSED" }), "transient");
    assert.equal(classifyError({ code: "EAI_AGAIN" }), "transient");
  });

  it("classifies invalid_grant message as 'auth' (revoked refresh)", () => {
    // googleapis sometimes surfaces this without a numeric code — it's
    // how we detect a user revoking access at the Google account level.
    assert.equal(
      classifyError({ message: "invalid_grant: Token has been expired or revoked." }),
      "auth"
    );
    assert.equal(
      classifyError(new Error("Token has been expired or revoked.")),
      "auth"
    );
  });

  it("classifies unknown shapes as 'unknown'", () => {
    assert.equal(classifyError({}), "unknown");
    assert.equal(classifyError("random string"), "unknown");
    assert.equal(classifyError(null), "unknown");
    assert.equal(classifyError(undefined), "unknown");
  });

  it("does NOT treat 400 / 422 as auth", () => {
    // Common mistake: lumping all 4xx into auth. Bad-request is a
    // permanent error but not a credential problem — flipping
    // needs_reconnect on a 400 would mis-direct the user.
    assert.equal(classifyError({ code: 400 }), "unknown");
    assert.equal(classifyError({ code: 422 }), "unknown");
  });
});

describe("calendar: errorMessage", () => {
  it("returns the Error.message when present", () => {
    assert.equal(errorMessage(new Error("boom")), "boom");
  });

  it("stringifies non-Error inputs", () => {
    assert.equal(errorMessage("plain string"), "plain string");
    // Object with a message field is preferred over String(obj).
    assert.equal(errorMessage({ message: "from object" }), "from object");
  });

  it("truncates to 500 chars to keep DB logs readable", () => {
    const long = "x".repeat(2000);
    assert.equal(errorMessage(new Error(long)).length, 500);
  });
});
