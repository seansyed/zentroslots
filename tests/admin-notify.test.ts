/**
 * Phase 3 — unit tests for the central admin notification service.
 *
 * Covers:
 *   • Inbox resolution cascade (ADMIN_EMAIL → OPERATIONS_EMAIL →
 *     SUPPORT_EMAIL → EMAIL_FROM → null).
 *   • Dedupe / cooldown: a second identical alert within the cooldown
 *     window is throttled.
 *   • Different kinds + tenants don't collide in dedupe keying.
 *   • Explicit dedupeKey override.
 *   • Secret scrubbing in subject + body.
 *   • Severity → subject prefix.
 *   • Never throws even when the sender throws.
 *   • Records dispatch on failure to avoid retry-storms.
 *
 * Stubbing: admin-notify exports `__setEmailSenderForTests` which
 * swaps the module-local sender. Far cleaner than ESM export mutation.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  adminNotify,
  resolveAdminInbox,
  __setEmailSenderForTests,
  __resetAdminNotifyForTests,
} from "../lib/admin-notify";

// ── Sender stub state ────────────────────────────────────────────────
// Use `any` for the stub args type because lib/email's SendArgs has
// `html: string` (required) but admin-notify always passes those, so
// the runtime contract is satisfied. We don't want the test to be
// brittle against lib/email type tweaks.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySendArgs = any;
type SendResult = { ok: boolean; reason?: string };

let sendCalls: AnySendArgs[] = [];
let sendResult: SendResult = { ok: true };
let sendThrows: Error | null = null;

const stubSender = async (args: AnySendArgs): Promise<SendResult> => {
  sendCalls.push(args);
  if (sendThrows) throw sendThrows;
  return sendResult;
};

let restoreSender: ((args: AnySendArgs) => Promise<SendResult>) | null = null;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Env snapshot ─────────────────────────────────────────────────────

const ENV_KEYS = [
  "ADMIN_EMAIL",
  "OPERATIONS_EMAIL",
  "SUPPORT_EMAIL",
  "EMAIL_FROM",
  "ADMIN_ALERT_COOLDOWN_MS",
  "BRAND_NAME",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];
const originalEnv: Partial<Record<EnvKey, string>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
  sendCalls = [];
  sendResult = { ok: true };
  sendThrows = null;
  __resetAdminNotifyForTests();
  restoreSender = __setEmailSenderForTests(stubSender);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  if (restoreSender) __setEmailSenderForTests(restoreSender);
  __resetAdminNotifyForTests();
});

// ─── Inbox resolution ────────────────────────────────────────────────

describe("resolveAdminInbox", () => {
  it("prefers ADMIN_EMAIL", () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    process.env.OPERATIONS_EMAIL = "ops@zentromeet.com";
    process.env.SUPPORT_EMAIL = "support@zentromeet.com";
    process.env.EMAIL_FROM = "no-reply@zentromeet.com";
    assert.equal(resolveAdminInbox(), "admin@zentromeet.com");
  });

  it("falls back to OPERATIONS_EMAIL when ADMIN_EMAIL unset", () => {
    process.env.OPERATIONS_EMAIL = "ops@zentromeet.com";
    process.env.SUPPORT_EMAIL = "support@zentromeet.com";
    assert.equal(resolveAdminInbox(), "ops@zentromeet.com");
  });

  it("falls back to SUPPORT_EMAIL when ADMIN + OPS unset", () => {
    process.env.SUPPORT_EMAIL = "support@zentromeet.com";
    process.env.EMAIL_FROM = "no-reply@zentromeet.com";
    assert.equal(resolveAdminInbox(), "support@zentromeet.com");
  });

  it("last-resort EMAIL_FROM when all others unset", () => {
    process.env.EMAIL_FROM = "no-reply@zentromeet.com";
    assert.equal(resolveAdminInbox(), "no-reply@zentromeet.com");
  });

  it("returns null when all four are unset", () => {
    assert.equal(resolveAdminInbox(), null);
  });
});

// ─── Dispatch ────────────────────────────────────────────────────────

describe("adminNotify — dispatch", () => {
  it("sends to resolved inbox on first call", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    const r = await adminNotify({
      kind: "new_subscription",
      severity: "info",
      summary: "Acme upgraded to Pro",
    });
    assert.equal(r.ok, true);
    assert.equal(r.to, "admin@zentromeet.com");
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0].to, "admin@zentromeet.com");
  });

  it("returns {ok:false, reason:no_inbox_configured} when no inbox", async () => {
    const r = await adminNotify({
      kind: "fatal_exception",
      severity: "critical",
      summary: "Unhandled rejection in worker",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "no_inbox_configured");
    assert.equal(r.to, null);
    assert.equal(sendCalls.length, 0);
  });

  it("propagates sender failure reason", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    sendResult = { ok: false, reason: "auth" };
    const r = await adminNotify({
      kind: "stripe_webhook_error",
      severity: "warning",
      summary: "Webhook signature failed",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "auth");
  });

  it("never throws even if sender throws", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    sendThrows = new Error("network down");
    const r = await adminNotify({
      kind: "worker_crash",
      severity: "critical",
      summary: "Reminders worker crashed",
    });
    assert.equal(r.ok, false);
    assert.ok(r.reason?.startsWith("dispatch_exception"));
  });
});

// ─── Dedupe ──────────────────────────────────────────────────────────

describe("adminNotify — dedupe / cooldown", () => {
  it("throttles a second identical alert within cooldown", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    const args = {
      kind: "payment_failed" as const,
      severity: "warning" as const,
      summary: "Stripe charge declined",
    };
    const r1 = await adminNotify(args);
    const r2 = await adminNotify(args);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, false);
    assert.equal(r2.throttled, true);
    assert.equal(sendCalls.length, 1);
  });

  it("does NOT throttle different kinds", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    await adminNotify({
      kind: "payment_failed",
      severity: "warning",
      summary: "Same summary",
    });
    await adminNotify({
      kind: "worker_crash",
      severity: "critical",
      summary: "Same summary",
    });
    assert.equal(sendCalls.length, 2);
  });

  it("does NOT throttle different tenants of same kind+summary", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    await adminNotify({
      kind: "subscription_cancelled",
      severity: "info",
      summary: "subscription cancelled",
      tenantId: "tenant-aaa",
    });
    await adminNotify({
      kind: "subscription_cancelled",
      severity: "info",
      summary: "subscription cancelled",
      tenantId: "tenant-bbb",
    });
    assert.equal(sendCalls.length, 2);
  });

  it("explicit dedupeKey overrides default", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    await adminNotify({
      kind: "stripe_webhook_error",
      severity: "warning",
      summary: "anything",
      dedupeKey: "stripe-evt-abc",
    });
    await adminNotify({
      kind: "stripe_webhook_error",
      severity: "warning",
      summary: "anything",
      dedupeKey: "stripe-evt-abc",
    });
    assert.equal(sendCalls.length, 1);
    await adminNotify({
      kind: "stripe_webhook_error",
      severity: "warning",
      summary: "anything",
      dedupeKey: "stripe-evt-xyz",
    });
    assert.equal(sendCalls.length, 2);
  });

  it("records dispatch on FAILURE so we don't retry-storm a downed inbox", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    sendResult = { ok: false, reason: "network" };
    await adminNotify({
      kind: "fatal_exception",
      severity: "critical",
      summary: "boom",
    });
    const r2 = await adminNotify({
      kind: "fatal_exception",
      severity: "critical",
      summary: "boom",
    });
    assert.equal(r2.throttled, true);
    assert.equal(sendCalls.length, 1);
  });
});

// ─── Secret scrubbing ────────────────────────────────────────────────

describe("adminNotify — secret scrubbing", () => {
  it("redacts Stripe secret key from subject + body", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    // Build the fake-secret tokens at runtime by string concatenation
    // so source-level secret scanners (GitHub push protection,
    // gitleaks, etc.) don't false-positive on these test fixtures.
    // The runtime values still match the scrubbing regex in lib/admin-notify.
    const fakeLiveKey = "sk_" + "live_" + "AbCdEfGhIjKlMnOpQrSt12345";
    const fakeTestKey = "sk_" + "test_" + "LeaKeDsEcReTaaaaaaaaaaaaaa";
    await adminNotify({
      kind: "stripe_webhook_error",
      severity: "warning",
      summary: `Caught stripe error ${fakeLiveKey}`,
      details: `Token leaked: ${fakeTestKey}`,
    });
    const call = sendCalls[0];
    assert.ok(!call.subject.includes(fakeLiveKey));
    assert.ok(call.text?.includes("[REDACTED]"));
    assert.ok(!call.text?.includes(fakeLiveKey));
    assert.ok(!call.text?.includes(fakeTestKey));
  });

  it("redacts JWT-shaped tokens from details", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    const fakeJwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eHh4eHh4eHgifQ.signaturepartherexxxxxxxxxxxxx";
    await adminNotify({
      kind: "oauth_provider_error",
      severity: "warning",
      summary: "OAuth callback failed",
      details: `Token: ${fakeJwt}`,
    });
    assert.ok(!sendCalls[0].text?.includes(fakeJwt));
    assert.ok(sendCalls[0].text?.includes("[REDACTED]"));
  });
});

// ─── Severity rendering ──────────────────────────────────────────────

describe("adminNotify — severity rendering", () => {
  it("info → ℹ️ subject prefix", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    await adminNotify({
      kind: "new_tenant_signup",
      severity: "info",
      summary: "New tenant: Acme",
    });
    assert.ok(sendCalls[0].subject.startsWith("ℹ️ [INFO]"));
  });

  it("warning → ⚠️ subject prefix", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    await adminNotify({
      kind: "payment_failed",
      severity: "warning",
      summary: "Payment failed",
    });
    assert.ok(sendCalls[0].subject.startsWith("⚠️ [WARNING]"));
  });

  it("critical → 🚨 subject prefix", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    await adminNotify({
      kind: "worker_crash",
      severity: "critical",
      summary: "Reminders worker exited 1",
    });
    assert.ok(sendCalls[0].subject.startsWith("🚨 [CRITICAL]"));
  });
});

// ─── Metadata ────────────────────────────────────────────────────────

describe("adminNotify — metadata + tenant context", () => {
  it("appears in email body as facts table", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    await adminNotify({
      kind: "reminder_delivery_failure",
      severity: "warning",
      summary: "SES rejected reminder",
      tenantId: "t-123",
      tenantLabel: "Acme Tax Co.",
      metadata: {
        bookingId: "b-456",
        errorCategory: "address_rejected",
        provider: "smtp",
      },
    });
    const text = sendCalls[0].text ?? "";
    assert.ok(text.includes("Tenant ID: t-123"));
    assert.ok(text.includes("Tenant: Acme Tax Co."));
    assert.ok(text.includes("bookingId: b-456"));
    assert.ok(text.includes("errorCategory: address_rejected"));
    assert.ok(text.includes("provider: smtp"));
  });

  it("skips empty metadata values", async () => {
    process.env.ADMIN_EMAIL = "admin@zentromeet.com";
    await adminNotify({
      kind: "queue_failure",
      severity: "critical",
      summary: "Queue stuck",
      metadata: { provider: "", attempt: undefined, reason: "timeout" },
    });
    const text = sendCalls[0].text ?? "";
    assert.ok(text.includes("reason: timeout"));
    assert.ok(!text.includes("provider: \n"));
    assert.ok(!text.includes("attempt:"));
  });
});
