/**
 * Phase ICAL-4 — health classifier + content classifier + diagnostics
 * tests.
 *
 * Coverage:
 *   • classifyFeedHealth — every state with its triggering
 *     condition, plus the boundary cases (just-under-stale,
 *     just-over-stale, just-under-error, etc.).
 *   • classifyFeedContent — HTML masquerade, password gate,
 *     expired share, empty calendar, valid.
 *   • buildFeedDiagnostics — redaction guarantees (no plaintext
 *     URL, no token, host-only).
 *   • State transitions — feed progresses healthy → warning →
 *     stale → error as time + failures advance.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyFeedHealth,
  FEED_HEALTH_THRESHOLDS,
} from "../lib/calendar/externalFeeds/feedHealth";
import { classifyFeedContent } from "../lib/calendar/externalFeeds/feedContentClassifier";
import { buildFeedDiagnostics } from "../lib/calendar/externalFeeds/feedDiagnostics";
import { encryptSecret } from "../lib/crypto";

const NOW = new Date("2026-05-25T12:00:00Z");
const ONE_HOUR_MS = 3_600_000;

// ─── classifyFeedHealth ───────────────────────────────────────────────

describe("classifyFeedHealth — basic states", () => {
  it("disabled wins over everything else", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: false,
        lastSyncedAt: new Date(NOW.getTime() - 10 * 24 * ONE_HOUR_MS), // very stale
        lastSyncStatus: "error",
        consecutiveFailures: 99,
        createdAt: new Date(NOW.getTime() - 30 * 24 * ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "disabled");
    assert.equal(h.tone, "slate");
  });

  it("healthy when last sync is recent + status ok", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 10 * 60_000), // 10 min ago
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: new Date(NOW.getTime() - ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "healthy");
    assert.equal(h.tone, "green");
  });

  it("warning when overdue past WARN_MINUTES but not stale yet", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 45 * 60_000), // 45 min ago
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: new Date(NOW.getTime() - ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "warning");
  });

  it("stale once last successful sync is >= STALE_HOURS old", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 25 * ONE_HOUR_MS), // 25h ago
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: new Date(NOW.getTime() - 30 * 24 * ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "stale");
    assert.equal(h.tone, "amber");
  });

  it("error after ERROR_FAILURE_THRESHOLD consecutive failures", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 10 * 60_000),
        lastSyncStatus: "fetch_failed",
        consecutiveFailures: FEED_HEALTH_THRESHOLDS.ERROR_FAILURE_THRESHOLD,
        createdAt: new Date(NOW.getTime() - 10 * ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "error");
    assert.equal(h.tone, "red");
  });

  it("ssrf_blocked → error on first occurrence (hard failure)", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000),
        lastSyncStatus: "ssrf_blocked",
        consecutiveFailures: 1, // below threshold
        createdAt: new Date(NOW.getTime() - ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "error");
  });

  it("too_large → error on first occurrence (hard failure)", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000),
        lastSyncStatus: "too_large",
        consecutiveFailures: 1,
        createdAt: new Date(NOW.getTime() - ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "error");
  });

  it("never-synced + recently-created → warning (grace period)", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: null,
        lastSyncStatus: null,
        consecutiveFailures: 0,
        createdAt: new Date(NOW.getTime() - 10 * 60_000), // 10 min ago
      },
      NOW,
    );
    assert.equal(h.state, "warning");
  });

  it("never-synced + created > STALE_HOURS ago → stale", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: null,
        lastSyncStatus: null,
        consecutiveFailures: 0,
        createdAt: new Date(NOW.getTime() - 26 * ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "stale");
  });
});

// ─── Boundary conditions ──────────────────────────────────────────────

describe("classifyFeedHealth — boundary conditions", () => {
  it("right AT WARN_MINUTES is still healthy (strict >)", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - FEED_HEALTH_THRESHOLDS.WARN_MINUTES * 60_000),
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: new Date(NOW.getTime() - ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "healthy");
  });

  it("right AT STALE_HOURS is stale (>=)", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - FEED_HEALTH_THRESHOLDS.STALE_HOURS * ONE_HOUR_MS),
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: new Date(NOW.getTime() - 30 * 24 * ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "stale");
  });

  it("failures < threshold + recent sync = warning, not error", () => {
    const h = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000),
        lastSyncStatus: "fetch_failed",
        consecutiveFailures: FEED_HEALTH_THRESHOLDS.ERROR_FAILURE_THRESHOLD - 1,
        createdAt: new Date(NOW.getTime() - ONE_HOUR_MS),
      },
      NOW,
    );
    assert.equal(h.state, "warning");
  });
});

// ─── State transition narrative ───────────────────────────────────────

describe("classifyFeedHealth — health transition narrative", () => {
  it("healthy → warning → stale → recovers to healthy", () => {
    const created = new Date(NOW.getTime() - 30 * 24 * ONE_HOUR_MS);

    // At t0: healthy.
    const t0 = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 5 * 60_000),
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: created,
      },
      NOW,
    );
    assert.equal(t0.state, "healthy");

    // 40 min later, no new sync: warning.
    const t1 = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 45 * 60_000),
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: created,
      },
      NOW,
    );
    assert.equal(t1.state, "warning");

    // 26h later, no sync: stale.
    const t2 = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 26 * ONE_HOUR_MS),
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: created,
      },
      NOW,
    );
    assert.equal(t2.state, "stale");

    // Fresh sync arrives — recovers to healthy.
    const t3 = classifyFeedHealth(
      {
        isEnabled: true,
        lastSyncedAt: new Date(NOW.getTime() - 60_000),
        lastSyncStatus: "ok",
        consecutiveFailures: 0,
        createdAt: created,
      },
      NOW,
    );
    assert.equal(t3.state, "healthy");
  });
});

// ─── classifyFeedContent ──────────────────────────────────────────────

describe("classifyFeedContent — content shape detection", () => {
  it("flags HTML body as html_masquerade", () => {
    const html = `<!DOCTYPE html><html><head><title>Error</title></head><body>404</body></html>`;
    const v = classifyFeedContent(html);
    assert.equal(v.classification, "html_masquerade");
    assert.match(v.userMessage, /HTML page/);
  });

  it("flags login form as password_protected", () => {
    const html = `<html><body><form><input type="password" name="pw"/><button>Sign in</button></form></body></html>`;
    const v = classifyFeedContent(html);
    assert.equal(v.classification, "password_protected");
  });

  it("flags non-ICS, non-HTML body as html_masquerade (generic)", () => {
    const json = `{"error": "not found"}`;
    const v = classifyFeedContent(json);
    assert.equal(v.classification, "html_masquerade");
  });

  it("flags VCALENDAR with no events + revoked wording as expired_share", () => {
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nX-WR-CALNAME:This calendar has been revoked\r\nEND:VCALENDAR\r\n`;
    const v = classifyFeedContent(body);
    assert.equal(v.classification, "expired_share");
  });

  it("flags VCALENDAR with no events + no error wording as empty_calendar", () => {
    const body = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nEND:VCALENDAR\r\n`;
    const v = classifyFeedContent(body);
    assert.equal(v.classification, "empty_calendar");
  });

  it("passes a normal VCALENDAR with at least one VEVENT", () => {
    const body = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const v = classifyFeedContent(body);
    assert.equal(v.classification, "valid");
  });

  it("honors Content-Type: text/html even if body coincidentally starts with VCALENDAR-like prefix", () => {
    // Pathological — should still flag html_masquerade based on
    // the declared content-type header.
    const v = classifyFeedContent("anything", "text/html; charset=utf-8");
    assert.equal(v.classification, "html_masquerade");
  });
});

// ─── buildFeedDiagnostics — redaction ─────────────────────────────────

describe("buildFeedDiagnostics — redaction guarantees", () => {
  const encrypted = encryptSecret("https://p49-caldav.icloud.com/published/2/SUPER-SECRET-PATH-1234");
  if (!encrypted) throw new Error("encryptSecret returned null");

  const baseFeed = {
    id: "feed-1",
    tenantId: "tenant-1",
    userId: "user-1",
    providerLabel: "My iCloud",
    providerKind: "apple_icloud" as const,
    feedUrlEncrypted: encrypted,
    isEnabled: true,
    lastSyncedAt: new Date(NOW.getTime() - 10 * 60_000),
    lastSyncStatus: "ok",
    lastError: null,
    etag: '"abc123"',
    lastModified: "Sat, 24 May 2026 12:00:00 GMT",
    nextSyncAfter: new Date(NOW.getTime() + 15 * 60_000),
    syncDurationMs: 1234,
    eventCount: 42,
    consecutiveFailures: 0,
    createdAt: new Date(NOW.getTime() - 30 * 24 * ONE_HOUR_MS),
    updatedAt: new Date(NOW.getTime() - 10 * 60_000),
  };

  it("exposes ONLY the URL host, never the path or secrets", () => {
    const d = buildFeedDiagnostics(baseFeed, { now: NOW });
    const json = JSON.stringify(d);
    assert.equal(d.urlHost, "p49-caldav.icloud.com");
    assert.ok(!json.includes("SUPER-SECRET-PATH-1234"), "leaked path segment");
    assert.ok(!json.includes("/published/"), "leaked path prefix");
  });

  it("exposes ETag presence as boolean, never the ETag value", () => {
    const d = buildFeedDiagnostics(baseFeed, { now: NOW });
    const json = JSON.stringify(d);
    assert.equal(d.supportsETag, true);
    assert.ok(!json.includes("abc123"), "leaked etag value");
  });

  it("exposes Last-Modified presence as boolean, never the value", () => {
    const d = buildFeedDiagnostics(baseFeed, { now: NOW });
    const json = JSON.stringify(d);
    assert.equal(d.supportsLastModified, true);
    assert.ok(!json.includes("24 May 2026"), "leaked last-modified value");
  });

  it("returns a working health classification embedded in the payload", () => {
    const d = buildFeedDiagnostics(baseFeed, { now: NOW });
    assert.equal(d.health.state, "healthy");
    assert.equal(d.health.tone, "green");
  });

  it("falls back to '(unknown)' for the host when decrypt fails", () => {
    const d = buildFeedDiagnostics(
      { ...baseFeed, feedUrlEncrypted: "v1:bad:bad:bad" },
      { now: NOW },
    );
    assert.equal(d.urlHost, "(unknown)");
  });
});
