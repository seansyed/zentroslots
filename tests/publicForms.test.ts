/**
 * Unit tests for the public-form pipeline.
 *
 *   - lib/email.ts: categorizeEmailError + renderers + verify with no SMTP_HOST
 *   - lib/notify-support.ts: inbox resolution fallback chain
 *   - /api/public/contact + /api/public/demo: validation, honeypot,
 *     rate limit, dispatch happy path with stub provider.
 *
 * The handlers are imported and invoked directly with a synthesized
 * NextRequest — no live HTTP server needed.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  categorizeEmailError,
  renderContactNotification,
  renderContactAutoresponder,
  renderDemoRequestNotification,
  renderDemoAutoresponder,
  getEmailProviderInfo,
  verifySmtpTransport,
} from "../lib/email";
import {
  resolveSupportInbox,
  resolveDemoInbox,
} from "../lib/notify-support";

// Force stub provider for the whole suite.
beforeEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.POSTMARK_TOKEN;
  delete process.env.SMTP_HOST;
  delete process.env.SUPPORT_EMAIL;
  delete process.env.DEMO_EMAIL;
});

// ─── categorizeEmailError ───────────────────────────────────────────

describe("email: categorizeEmailError", () => {
  it("maps EAUTH to auth", () => {
    const e = Object.assign(new Error("Invalid login"), { code: "EAUTH" });
    assert.equal(categorizeEmailError(e), "auth");
  });
  it("maps 535 response code to auth", () => {
    const e = Object.assign(new Error("Authentication failed"), { responseCode: 535 });
    assert.equal(categorizeEmailError(e), "auth");
  });
  it("maps ECONNREFUSED to network", () => {
    const e = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    assert.equal(categorizeEmailError(e), "network");
  });
  it("maps ETIMEDOUT to network", () => {
    const e = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    assert.equal(categorizeEmailError(e), "network");
  });
  it("maps TLS errors", () => {
    const e = Object.assign(new Error("TLS certificate invalid"), { code: "ESOCKET" });
    assert.equal(categorizeEmailError(e), "tls");
  });
  it("maps 421 to rate_limit", () => {
    const e = Object.assign(new Error("Throttled"), { responseCode: 421 });
    assert.equal(categorizeEmailError(e), "rate_limit");
  });
  it("maps 550 to address_rejected", () => {
    const e = Object.assign(new Error("Recipient rejected"), { responseCode: 550 });
    assert.equal(categorizeEmailError(e), "address_rejected");
  });
  it("maps a Resend message to provider_api", () => {
    assert.equal(categorizeEmailError(new Error("Resend 422: invalid")), "provider_api");
  });
  it("maps config errors", () => {
    assert.equal(categorizeEmailError(new Error("SMTP_HOST not set")), "config");
  });
  it("falls through to unknown", () => {
    assert.equal(categorizeEmailError(new Error("kaboom")), "unknown");
  });
  it("handles null/undefined safely", () => {
    assert.equal(categorizeEmailError(null), "unknown");
    assert.equal(categorizeEmailError(undefined), "unknown");
  });
});

// ─── verifySmtpTransport (stub mode) ────────────────────────────────

describe("email: verifySmtpTransport in stub mode", () => {
  it("reports ok=true with no_verify_needed when provider is stub", async () => {
    const r = await verifySmtpTransport({ force: true });
    assert.equal(r.ok, true);
    assert.match(r.detail ?? "", /no_verify_needed|stub/);
  });
});

// ─── getEmailProviderInfo ───────────────────────────────────────────

describe("email: getEmailProviderInfo", () => {
  it("reports stub provider when nothing configured", () => {
    const info = getEmailProviderInfo();
    assert.equal(info.provider, "stub");
  });
  it("never leaks SMTP_PASS", () => {
    process.env.SMTP_HOST = "email-smtp.us-east-1.amazonaws.com";
    process.env.SMTP_USER = "AKIAEXAMPLE";
    process.env.SMTP_PASS = "secret123";
    const info = getEmailProviderInfo();
    assert.equal(info.provider, "smtp");
    assert.equal(info.smtpHost, "email-smtp.us-east-1.amazonaws.com");
    assert.ok(!JSON.stringify(info).includes("secret123"));
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });
});

// ─── Renderers ──────────────────────────────────────────────────────

describe("email: renderContactNotification", () => {
  it("escapes HTML in user input", () => {
    const r = renderContactNotification({
      name: "<script>alert(1)</script>",
      email: "x@example.com",
      message: "Hello & goodbye <b>now</b>",
    });
    assert.ok(!r.html.includes("<script>alert(1)</script>"));
    assert.ok(r.html.includes("&lt;script&gt;"));
    assert.ok(r.html.includes("Hello &amp; goodbye"));
  });
  it("includes plain text", () => {
    const r = renderContactNotification({
      name: "Jane",
      email: "j@example.com",
      message: "msg",
    });
    assert.match(r.text, /Jane/);
    assert.match(r.text, /j@example\.com/);
  });
});

describe("email: renderContactAutoresponder", () => {
  it("addresses the submitter by name + cites support email", () => {
    const r = renderContactAutoresponder({
      name: "Jane",
      supportEmail: "support@zentrobiz.com",
      brandName: "ZentroBiz",
    });
    assert.match(r.html, /Jane/);
    assert.match(r.html, /support@zentrobiz\.com/);
    assert.match(r.subject, /ZentroBiz/);
  });
});

describe("email: renderDemoRequestNotification + autoresponder", () => {
  it("renders demo notification with optional fields", () => {
    const r = renderDemoRequestNotification({
      name: "Bob",
      email: "b@acme.com",
      company: "Acme",
      teamSize: "20-50",
      useCase: "Lead capture",
    });
    assert.match(r.html, /Acme/);
    assert.match(r.html, /20-50/);
    assert.match(r.html, /Lead capture/);
  });
  it("autoresponder uses brand name", () => {
    const r = renderDemoAutoresponder({
      name: "Bob",
      supportEmail: "sales@example.com",
      brandName: "Foo",
    });
    assert.match(r.subject, /Foo/);
    assert.match(r.html, /Bob/);
  });
});

// ─── notify-support: inbox resolution ───────────────────────────────

describe("notify-support: resolveSupportInbox fallback", () => {
  it("returns SUPPORT_EMAIL when set", () => {
    process.env.SUPPORT_EMAIL = "support@x.com";
    process.env.EMAIL_FROM = "noreply@x.com";
    assert.equal(resolveSupportInbox(), "support@x.com");
  });
  it("falls back to EMAIL_FROM", () => {
    delete process.env.SUPPORT_EMAIL;
    process.env.EMAIL_FROM = "noreply@x.com";
    assert.equal(resolveSupportInbox(), "noreply@x.com");
  });
  it("returns null when both unset", () => {
    delete process.env.SUPPORT_EMAIL;
    delete process.env.EMAIL_FROM;
    assert.equal(resolveSupportInbox(), null);
  });
});

describe("notify-support: resolveDemoInbox fallback chain", () => {
  it("DEMO_EMAIL takes precedence", () => {
    process.env.DEMO_EMAIL = "demo@x.com";
    process.env.SUPPORT_EMAIL = "support@x.com";
    process.env.EMAIL_FROM = "noreply@x.com";
    assert.equal(resolveDemoInbox(), "demo@x.com");
  });
  it("falls through to SUPPORT_EMAIL", () => {
    delete process.env.DEMO_EMAIL;
    process.env.SUPPORT_EMAIL = "support@x.com";
    process.env.EMAIL_FROM = "noreply@x.com";
    assert.equal(resolveDemoInbox(), "support@x.com");
  });
  it("falls through to EMAIL_FROM as last resort", () => {
    delete process.env.DEMO_EMAIL;
    delete process.env.SUPPORT_EMAIL;
    process.env.EMAIL_FROM = "noreply@x.com";
    assert.equal(resolveDemoInbox(), "noreply@x.com");
  });
});

// ─── /api/public/contact handler ────────────────────────────────────
// Synthesize NextRequest and invoke POST directly.

function reqWith(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3001/api/public/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.99", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/api/public/contact: validation + honeypot", () => {
  beforeEach(() => {
    process.env.SUPPORT_EMAIL = "support@x.com";
    process.env.EMAIL_FROM = "noreply@x.com";
  });

  it("returns 200 ok=true even on bad input (no schema leakage)", async () => {
    const { POST } = await import("../app/api/public/contact/route");
    const res = await POST(reqWith({ name: "" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.received, false);
  });

  it("silently drops honeypot submissions", async () => {
    const { POST } = await import("../app/api/public/contact/route");
    const res = await POST(
      reqWith({
        name: "Bot",
        email: "b@x.com",
        message: "hello there friend hello",
        website: "https://spam.example.com",
      }, { "x-forwarded-for": "198.51.100.7" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.notified, undefined); // dispatch never ran
  });

  it("dispatches a valid contact submission (stub provider)", async () => {
    const { POST } = await import("../app/api/public/contact/route");
    const res = await POST(
      reqWith({
        name: "Jane",
        email: "jane@example.com",
        company: "Acme",
        message: "This is my message",
      }, { "x-forwarded-for": "198.51.100.10" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    // Stub provider returns ok:true so notified should be true.
    assert.equal(body.notified, true);
    assert.equal(body.autoresponded, true);
  });

  it("rate-limits after 5 submissions", async () => {
    const { POST } = await import("../app/api/public/contact/route");
    const ip = "198.51.100.20";
    for (let i = 0; i < 5; i++) {
      await POST(
        reqWith({ name: "X", email: "x@y.com", message: "valid message body" }, { "x-forwarded-for": ip })
      );
    }
    const sixth = await POST(
      reqWith({ name: "X", email: "x@y.com", message: "valid message body" }, { "x-forwarded-for": ip })
    );
    assert.equal(sixth.status, 429);
    assert.ok(sixth.headers.get("retry-after"));
  });

  it("drops obvious spam (multiple URLs)", async () => {
    const { POST } = await import("../app/api/public/contact/route");
    const res = await POST(
      reqWith({
        name: "Spammer",
        email: "s@x.com",
        message: "buy now http://a.com http://b.com http://c.com http://d.com",
      }, { "x-forwarded-for": "198.51.100.30" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // Should have been dropped before dispatch.
    assert.equal(body.notified, undefined);
  });
});

// ─── /api/public/demo handler ───────────────────────────────────────

describe("/api/public/demo: validation + dispatch", () => {
  beforeEach(() => {
    process.env.DEMO_EMAIL = "demo@x.com";
    process.env.SUPPORT_EMAIL = "support@x.com";
    process.env.EMAIL_FROM = "noreply@x.com";
  });

  function demoReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
    return new NextRequest("http://localhost:3001/api/public/demo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("returns 200 ok=true on bad input", async () => {
    const { POST } = await import("../app/api/public/demo/route");
    const res = await POST(demoReq({ name: "" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.received, false);
  });

  it("dispatches a valid demo request", async () => {
    const { POST } = await import("../app/api/public/demo/route");
    const res = await POST(
      demoReq({
        name: "Alice",
        email: "alice@startup.io",
        company: "Startup",
        teamSize: "5-20",
        useCase: "scheduling",
      }, { "x-forwarded-for": "198.51.100.60" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.notified, true);
    assert.equal(body.autoresponded, true);
  });

  it("honeypot drops bot demo submissions", async () => {
    const { POST } = await import("../app/api/public/demo/route");
    const res = await POST(
      demoReq({
        name: "Bot",
        email: "b@x.com",
        website: "http://spam.example",
      }, { "x-forwarded-for": "198.51.100.61" })
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.notified, undefined);
  });

  it("rate-limits demo requests after 3", async () => {
    const { POST } = await import("../app/api/public/demo/route");
    const ip = "198.51.100.70";
    for (let i = 0; i < 3; i++) {
      await POST(demoReq({ name: "X", email: "x@y.com" }, { "x-forwarded-for": ip }));
    }
    const fourth = await POST(demoReq({ name: "X", email: "x@y.com" }, { "x-forwarded-for": ip }));
    assert.equal(fourth.status, 429);
  });
});
