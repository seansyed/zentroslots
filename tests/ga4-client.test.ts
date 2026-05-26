/**
 * Phase GA4 — unit tests for the typed client helpers.
 *
 * What we cover:
 *   • getMeasurementId() — env var presence + format validation.
 *   • isGAEnabled() — combines env + browser-context check.
 *   • initializeGA() — idempotent dataLayer + gtag stub setup.
 *   • trackPageView() / trackEvent() — call shape sent to gtag().
 *   • ALL_GA4_EVENT_NAMES — closed-enum sanity check.
 *
 * Strategy:
 *   We stub a minimal `window` object on globalThis before importing
 *   the module under test, because the client module short-circuits
 *   on `typeof window === "undefined"`. We capture gtag calls into a
 *   sink array, then assert on the call signatures.
 *
 *   `process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID` is mutated per-test
 *   to drive each branch. The env var is read fresh on every call,
 *   so this just works without module-cache gymnastics.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ─── Shared fake window helpers ──────────────────────────────────────

type GtagCall = { args: unknown[] };
type FakeWindow = {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
  location?: { origin: string };
};

let calls: GtagCall[] = [];
const originalWindow = (globalThis as { window?: unknown }).window;
const originalEnv = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

function installFakeWindow(): FakeWindow {
  const fake: FakeWindow = {
    location: { origin: "https://app.zentromeet.com" },
  };
  // The client module both reads + writes window.gtag — we set up a
  // capturing stub so assertions can inspect the exact call payload.
  fake.dataLayer = [];
  fake.gtag = (...args: unknown[]) => {
    calls.push({ args });
  };
  (globalThis as { window: FakeWindow }).window = fake;
  return fake;
}

function removeFakeWindow(): void {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window: unknown }).window = originalWindow;
  }
}

async function freshClient(): Promise<typeof import("../lib/analytics/ga4/client")> {
  // Each test imports fresh so the module isn't holding stale state
  // captured from a prior test's stub.
  const mod = await import(
    `../lib/analytics/ga4/client?cachebust=${Math.random()}`
  );
  return mod;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  removeFakeWindow();
  if (originalEnv === undefined) {
    delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  } else {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = originalEnv;
  }
});

// ─── getMeasurementId ────────────────────────────────────────────────

describe("getMeasurementId", () => {
  it("returns null when env var is unset", async () => {
    delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
    const { getMeasurementId } = await freshClient();
    assert.equal(getMeasurementId(), null);
  });

  it("returns null when env var is empty string", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "";
    const { getMeasurementId } = await freshClient();
    assert.equal(getMeasurementId(), null);
  });

  it("returns null when env var is wrong shape", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "UA-12345-6";
    const { getMeasurementId } = await freshClient();
    assert.equal(getMeasurementId(), null);
  });

  it("returns null when env var is missing the G- prefix", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "ZD40BSLJRY";
    const { getMeasurementId } = await freshClient();
    assert.equal(getMeasurementId(), null);
  });

  it("returns the id when env var matches G-[A-Z0-9]{6,}", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    const { getMeasurementId } = await freshClient();
    assert.equal(getMeasurementId(), "G-ZD40BSLJRY");
  });
});

// ─── isGAEnabled ─────────────────────────────────────────────────────

describe("isGAEnabled", () => {
  it("false during SSR (no window) even with env set", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    removeFakeWindow();
    const { isGAEnabled } = await freshClient();
    assert.equal(isGAEnabled(), false);
  });

  it("false when window present but env missing", async () => {
    delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
    installFakeWindow();
    const { isGAEnabled } = await freshClient();
    assert.equal(isGAEnabled(), false);
  });

  it("true when window present + env well-formed", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    installFakeWindow();
    const { isGAEnabled } = await freshClient();
    assert.equal(isGAEnabled(), true);
  });
});

// ─── initializeGA ────────────────────────────────────────────────────

describe("initializeGA", () => {
  it("no-op when env is missing — no dataLayer mutation", async () => {
    delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
    const fake = installFakeWindow();
    // Reset what installFakeWindow set so we can detect mutation.
    fake.dataLayer = undefined;
    fake.gtag = undefined;
    const { initializeGA } = await freshClient();
    initializeGA();
    assert.equal(fake.dataLayer, undefined);
    assert.equal(fake.gtag, undefined);
  });

  it("seeds dataLayer + gtag when missing", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    const fake = installFakeWindow();
    fake.dataLayer = undefined;
    fake.gtag = undefined;
    const { initializeGA } = await freshClient();
    initializeGA();
    assert.ok(Array.isArray(fake.dataLayer));
    assert.equal(typeof fake.gtag, "function");
  });

  it("idempotent — second call doesn't replace existing gtag", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    const fake = installFakeWindow();
    const { initializeGA } = await freshClient();
    initializeGA();
    const firstGtag = fake.gtag;
    initializeGA();
    assert.equal(fake.gtag, firstGtag);
  });
});

// ─── trackPageView ───────────────────────────────────────────────────

describe("trackPageView", () => {
  it("no-op when env is missing — no gtag calls", async () => {
    delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
    installFakeWindow();
    const { trackPageView } = await freshClient();
    trackPageView("/pricing");
    assert.equal(calls.length, 0);
  });

  it("calls gtag with event + page_view + path + send_to", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    installFakeWindow();
    const { trackPageView } = await freshClient();
    trackPageView("/pricing");
    assert.equal(calls.length, 1);
    const [cmd, name, params] = calls[0].args as [
      string,
      string,
      Record<string, unknown>,
    ];
    assert.equal(cmd, "event");
    assert.equal(name, "page_view");
    assert.equal(params.page_path, "/pricing");
    assert.equal(params.send_to, "G-ZD40BSLJRY");
  });

  it("appends search string with leading ?", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    installFakeWindow();
    const { trackPageView } = await freshClient();
    trackPageView("/dashboard", "tab=upcoming");
    const params = calls[0].args[2] as Record<string, unknown>;
    assert.equal(params.page_path, "/dashboard?tab=upcoming");
  });

  it("does not double the leading ?", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    installFakeWindow();
    const { trackPageView } = await freshClient();
    trackPageView("/dashboard", "?tab=upcoming");
    const params = calls[0].args[2] as Record<string, unknown>;
    assert.equal(params.page_path, "/dashboard?tab=upcoming");
  });
});

// ─── trackEvent ──────────────────────────────────────────────────────

describe("trackEvent", () => {
  it("no-op when env is missing", async () => {
    delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
    installFakeWindow();
    const { trackEvent } = await freshClient();
    trackEvent("signup_completed");
    assert.equal(calls.length, 0);
  });

  it("fires event with name + empty params when no params given", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    installFakeWindow();
    const { trackEvent } = await freshClient();
    trackEvent("signup_completed");
    assert.equal(calls.length, 1);
    const [cmd, name, params] = calls[0].args as [
      string,
      string,
      Record<string, unknown>,
    ];
    assert.equal(cmd, "event");
    assert.equal(name, "signup_completed");
    assert.deepEqual(params, {});
  });

  it("strips undefined, null, and empty-string params", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    installFakeWindow();
    const { trackEvent } = await freshClient();
    trackEvent("booking_completed", {
      plan: undefined,
      service_name: "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      interval: null as any,
      value_bucket: "paid",
    });
    const params = calls[0].args[2] as Record<string, unknown>;
    assert.deepEqual(params, { value_bucket: "paid" });
  });

  it("forwards non-empty params verbatim", async () => {
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-ZD40BSLJRY";
    installFakeWindow();
    const { trackEvent } = await freshClient();
    trackEvent("subscription_started", { plan: "pro", interval: "year" });
    const params = calls[0].args[2] as Record<string, unknown>;
    assert.deepEqual(params, { plan: "pro", interval: "year" });
  });
});

// ─── ALL_GA4_EVENT_NAMES ─────────────────────────────────────────────

describe("ALL_GA4_EVENT_NAMES", () => {
  it("contains every event documented in docs/GA4_ANALYTICS.md", async () => {
    const { ALL_GA4_EVENT_NAMES } = await freshClient();
    const expected = [
      "signup_started",
      "signup_completed",
      "demo_requested",
      "booking_completed",
      "stripe_checkout_started",
      "subscription_started",
      "calendar_connected",
      "google_connected",
      "microsoft_connected",
    ];
    // Ordering MAY drift, but the set must be identical. We sort
    // both sides so a future re-order doesn't break the test.
    assert.deepEqual(
      [...ALL_GA4_EVENT_NAMES].sort(),
      expected.sort(),
      "GA4 event enum drifted from docs",
    );
  });

  it("has no duplicates", async () => {
    const { ALL_GA4_EVENT_NAMES } = await freshClient();
    assert.equal(
      ALL_GA4_EVENT_NAMES.length,
      new Set(ALL_GA4_EVENT_NAMES).size,
      "duplicate event name in enum",
    );
  });
});
