import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTokenError,
  errorMessage,
  recordPushDiagnostic,
  getPushDiagnostics,
  subscribePushDiagnostics,
  summarizePush,
  INITIAL_PUSH_DIAGNOSTICS,
  __resetPushDiagnostics,
  type PushDiagnostics,
} from "../src/lib/pushDiagnostics";

// The EXACT error captured from live adb logcat on the device — the
// Android root cause we must recognize immediately next time.
const REAL_FIREBASE_ERROR =
  "Default FirebaseApp failed to initialize because no default options were found. " +
  "This usually means that com.google.gms:google-services was not applied to your gradle project.";

describe("classifyTokenError — Firebase/FCM not-configured signature", () => {
  it("flags the real production Firebase error as firebaseAvailable=false", () => {
    const r = classifyTokenError(new Error(REAL_FIREBASE_ERROR));
    assert.equal(r.firebaseAvailable, false);
    assert.equal(r.reason, "firebase_not_configured");
  });

  it("flags 'Default FirebaseApp is not initialized' variants", () => {
    assert.equal(
      classifyTokenError(new Error("Default FirebaseApp is not initialized in this process")).firebaseAvailable,
      false,
    );
  });

  it("flags FCM transport faults (SERVICE_NOT_AVAILABLE)", () => {
    const r = classifyTokenError(new Error("java.io.IOException: SERVICE_NOT_AVAILABLE"));
    assert.equal(r.firebaseAvailable, false);
    assert.equal(r.reason, "fcm_unavailable");
  });

  it("does NOT over-assert on unrelated/transient errors (returns null)", () => {
    assert.equal(classifyTokenError(new Error("Network request failed")).firebaseAvailable, null);
    assert.equal(classifyTokenError(new Error("timeout")).firebaseAvailable, null);
  });

  it("accepts string and unknown throws without crashing", () => {
    assert.equal(classifyTokenError("com.google.gms:google-services was not applied").firebaseAvailable, false);
    assert.equal(classifyTokenError(null).firebaseAvailable, null);
    assert.equal(classifyTokenError(undefined).firebaseAvailable, null);
    assert.equal(classifyTokenError({ weird: true }).firebaseAvailable, null);
  });
});

describe("errorMessage — safe flatten + truncate", () => {
  it("uses Error.message, collapses whitespace", () => {
    assert.equal(errorMessage(new Error("line1\n  line2")), "line1 line2");
  });
  it("truncates to 300 chars", () => {
    assert.ok(errorMessage(new Error("x".repeat(1000))).length <= 300);
  });
  it("handles non-Error values", () => {
    assert.equal(errorMessage("boom"), "boom");
    assert.equal(errorMessage(null), "null");
  });
});

describe("recordPushDiagnostic — snapshot merge", () => {
  beforeEach(() => __resetPushDiagnostics());

  it("starts at the initial snapshot", () => {
    assert.deepEqual(getPushDiagnostics(), INITIAL_PUSH_DIAGNOSTICS);
  });

  it("merges partial patches and stamps updatedAt", () => {
    recordPushDiagnostic({ stage: "token", permissionGranted: true });
    const d = getPushDiagnostics();
    assert.equal(d.stage, "token");
    assert.equal(d.permissionGranted, true);
    assert.equal(d.tokenObtained, false); // untouched
    assert.ok(typeof d.updatedAt === "number");
  });

  it("notifies subscribers only while subscribed", () => {
    let fired = 0;
    const stop = subscribePushDiagnostics(() => {
      fired += 1;
    });
    recordPushDiagnostic({ stage: "upload" });
    stop();
    recordPushDiagnostic({ stage: "ready" });
    assert.equal(fired, 1);
  });

  it("models the confirmed failure path → push not available", () => {
    recordPushDiagnostic({ permissionGranted: true });
    recordPushDiagnostic({
      stage: "failed",
      firebaseAvailable: false,
      tokenObtained: false,
      pushAvailable: false,
      lastError: REAL_FIREBASE_ERROR,
      lastErrorStage: "token",
    });
    const d = getPushDiagnostics();
    assert.equal(d.pushAvailable, false);
    assert.equal(d.firebaseAvailable, false);
    assert.match(summarizePush(d), /Firebase\/FCM not configured/i);
  });

  it("models the success path → push ready", () => {
    recordPushDiagnostic({ permissionGranted: true });
    recordPushDiagnostic({ tokenObtained: true, firebaseAvailable: true });
    recordPushDiagnostic({ stage: "ready", tokenUploaded: true, pushAvailable: true });
    assert.equal(summarizePush(getPushDiagnostics()), "Push ready");
  });
});

describe("summarizePush — human one-liner", () => {
  beforeEach(() => __resetPushDiagnostics());
  it("idle when nothing has run", () => {
    assert.equal(summarizePush(getPushDiagnostics()), "Not started");
  });
  it("permission-blocked", () => {
    const d: PushDiagnostics = { ...INITIAL_PUSH_DIAGNOSTICS, stage: "failed", permissionGranted: false };
    assert.match(summarizePush(d), /permission/i);
  });
  it("upload-failed", () => {
    const d: PushDiagnostics = {
      ...INITIAL_PUSH_DIAGNOSTICS,
      stage: "failed",
      tokenObtained: true,
      lastErrorStage: "upload",
    };
    assert.match(summarizePush(d), /upload/i);
  });
});
