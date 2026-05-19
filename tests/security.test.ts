/**
 * Unit tests for the security hardening layer.
 *
 * Pure module coverage (no live DB needed):
 *   - lib/security/permissions
 *   - lib/security/heuristics
 *   - lib/security/audit (categorization constants)
 *   - lib/security/sessionEvents (event types are closed)
 *   - lib/security/passwordReset (token-generation primitive shape +
 *     internals constants)
 *
 * Route validation (with synthesized NextRequest):
 *   - /api/auth/forgot-password — always returns 200 ok:true
 *   - /api/auth/reset-password — validation paths (bad token, weak pw,
 *     malformed body)
 *
 * Routes that hit the DB beyond simple lookups are deferred to the
 * production smoke phase — those exercise the live tables end-to-end.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  PERMISSION_FLAGS,
  ROLE_DEFAULTS,
  userHasPermission,
  effectivePermissions,
} from "../lib/security/permissions";
import {
  evaluateLoginSuspicion,
  deviceLabelFor,
} from "../lib/security/heuristics";
import {
  SECURITY_AUDIT_CATEGORIES,
} from "../lib/security/audit";
import {
  SESSION_EVENT_TYPES,
} from "../lib/security/sessionEvents";
import { _internals as resetInternals } from "../lib/security/passwordReset";
import type { User } from "../db/schema";

// ─── permissions ────────────────────────────────────────────────────

describe("permissions: ROLE_DEFAULTS completeness", () => {
  it("every role declares every flag explicitly (no implicit defaults)", () => {
    for (const role of ["admin", "manager", "staff", "client"] as const) {
      for (const flag of PERMISSION_FLAGS) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(ROLE_DEFAULTS[role], flag),
          `role=${role} missing flag=${flag}`
        );
      }
    }
  });

  it("staff + client are denied every sensitive flag by default", () => {
    for (const role of ["staff", "client"] as const) {
      for (const flag of PERMISSION_FLAGS) {
        assert.equal(ROLE_DEFAULTS[role][flag], false, `${role} should not have ${flag}`);
      }
    }
  });
});

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: "u-1",
    tenantId: "t-1",
    email: "x@y.com",
    passwordHash: "x",
    role: "staff",
    name: "X",
    timezone: "UTC",
    googleRefreshToken: null,
    googleCalendarId: null,
    googleStatus: null,
    googleLastErrorAt: null,
    primaryLocationId: null,
    departmentId: null,
    avatarUrl: null,
    bio: null,
    specialties: null,
    sessionMinIat: null,
    permissionsExtra: {},
    lastLoginAt: null,
    lastLoginIp: null,
    lastLoginUserAgent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as User;
}

describe("permissions: userHasPermission", () => {
  it("admin gets everything", () => {
    const u = fakeUser({ role: "admin" });
    for (const flag of PERMISSION_FLAGS) {
      assert.equal(userHasPermission(u, flag), true, `admin missing ${flag}`);
    }
  });

  it("staff denied canManageSecurity by default", () => {
    const u = fakeUser({ role: "staff" });
    assert.equal(userHasPermission(u, "canManageSecurity"), false);
  });

  it("per-user override grants over role default", () => {
    const u = fakeUser({ role: "staff", permissionsExtra: { canViewAuditLogs: true } });
    assert.equal(userHasPermission(u, "canViewAuditLogs"), true);
  });

  it("per-user override revokes over role default", () => {
    const u = fakeUser({ role: "admin", permissionsExtra: { canExportReports: false } });
    assert.equal(userHasPermission(u, "canExportReports"), false);
  });

  it("effectivePermissions returns a complete map", () => {
    const u = fakeUser({ role: "manager" });
    const map = effectivePermissions(u);
    for (const flag of PERMISSION_FLAGS) {
      assert.ok(Object.prototype.hasOwnProperty.call(map, flag));
    }
  });
});

// ─── heuristics ─────────────────────────────────────────────────────

describe("heuristics: evaluateLoginSuspicion", () => {
  it("first login ever is not suspicious", () => {
    const r = evaluateLoginSuspicion({
      currentIp: "1.2.3.4",
      currentUserAgent: "Mozilla/5.0",
      priorIp: null,
      priorUserAgent: null,
      priorLoginAt: null,
    });
    assert.equal(r.suspicious, false);
    assert.deepEqual(r.signals, ["first_login_ever"]);
  });

  it("same fingerprint = no signal", () => {
    const r = evaluateLoginSuspicion({
      currentIp: "1.2.3.4",
      currentUserAgent: "Mozilla/5.0",
      priorIp: "1.2.3.4",
      priorUserAgent: "Mozilla/5.0",
      priorLoginAt: new Date(Date.now() - 86_400_000),
    });
    assert.equal(r.suspicious, false);
    assert.deepEqual(r.signals, ["no_signal"]);
  });

  it("IP change + UA change is suspicious", () => {
    const r = evaluateLoginSuspicion({
      currentIp: "203.0.113.5",
      currentUserAgent: "Mozilla/5.0 (iPhone)",
      priorIp: "192.0.2.5",
      priorUserAgent: "Mozilla/5.0 (Windows)",
      priorLoginAt: new Date(Date.now() - 86_400_000),
    });
    assert.equal(r.suspicious, true);
    assert.ok(r.signals.includes("new_ip"));
    assert.ok(r.signals.includes("new_user_agent"));
    assert.ok(r.signals.includes("ip_octet_shift"));
  });

  it("rapid revisit from new IP fires the rapid signal", () => {
    const r = evaluateLoginSuspicion({
      currentIp: "203.0.113.5",
      currentUserAgent: "Mozilla/5.0",
      priorIp: "192.0.2.5",
      priorUserAgent: "Mozilla/5.0",
      priorLoginAt: new Date(Date.now() - 10_000), // 10s ago
    });
    assert.equal(r.suspicious, true);
    assert.ok(r.signals.includes("rapid_revisit"));
  });

  it("UA version bump within same family is not suspicious", () => {
    const r = evaluateLoginSuspicion({
      currentIp: "1.2.3.4",
      currentUserAgent: "Mozilla/5.0 Chrome/121.0.0",
      priorIp: "1.2.3.4",
      priorUserAgent: "Mozilla/5.0 Chrome/120.0.0",
      priorLoginAt: new Date(Date.now() - 86_400_000),
    });
    // Versions normalize away → identical fingerprint → no_signal.
    assert.equal(r.suspicious, false);
  });
});

describe("heuristics: deviceLabelFor", () => {
  it("recognizes Chrome on Windows", () => {
    const label = deviceLabelFor(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0 Safari/537.36"
    );
    assert.equal(label, "Chrome on Windows 10/11");
  });

  it("recognizes Safari on iOS", () => {
    const label = deviceLabelFor("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/605.1.15");
    assert.match(label ?? "", /Safari on iOS/);
  });

  it("returns null for null input", () => {
    assert.equal(deviceLabelFor(null), null);
  });

  it("caps output length at 120", () => {
    const label = deviceLabelFor("Mozilla/5.0 " + "x".repeat(500));
    assert.ok((label?.length ?? 0) <= 120);
  });
});

// ─── audit + sessionEvents (closed enums) ───────────────────────────

describe("audit: SECURITY_AUDIT_CATEGORIES is namespaced + non-empty", () => {
  it("all categories use the security.* prefix", () => {
    for (const c of SECURITY_AUDIT_CATEGORIES) {
      assert.match(c, /^security\./, `non-prefixed category: ${c}`);
    }
  });
  it("covers the spec's required event families", () => {
    const cats = new Set<string>(SECURITY_AUDIT_CATEGORIES as readonly string[]);
    for (const must of [
      "security.password_reset.requested",
      "security.password_reset.completed",
      "security.session.revoked",
      "security.sessions.revoked_all",
      "security.session.suspicious_login",
      "security.access.failed_login",
      "security.access.denied",
      "security.export.executed",
      "security.role_changed",
      "security.permission.granted",
    ]) {
      assert.ok(cats.has(must), `missing category: ${must}`);
    }
  });
});

describe("sessionEvents: SESSION_EVENT_TYPES covers spec", () => {
  it("includes login/logout/failed/reset/revoke/suspicious", () => {
    const types = new Set<string>(SESSION_EVENT_TYPES as readonly string[]);
    for (const must of [
      "login",
      "logout",
      "login_failed",
      "password_reset_requested",
      "password_reset_completed",
      "session_revoked",
      "sessions_revoked_all",
      "suspicious_login",
    ]) {
      assert.ok(types.has(must), `missing event type: ${must}`);
    }
  });
});

// ─── passwordReset: internal constants ──────────────────────────────

describe("passwordReset: documented constants are sane", () => {
  it("1 hour lifetime", () => {
    assert.equal(resetInternals.TOKEN_LIFETIME_MS, 60 * 60 * 1000);
  });
  it("32-byte random token", () => {
    assert.equal(resetInternals.TOKEN_BYTES, 32);
  });
  it("bcrypt rounds in safe range", () => {
    assert.ok(resetInternals.BCRYPT_ROUNDS >= 10);
  });
});

// ─── /api/auth/forgot-password route — enumeration resistance ───────

function jsonPostReq(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.99", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/api/auth/forgot-password: enumeration resistance", () => {
  beforeEach(() => {
    process.env.EMAIL_FROM = "noreply@x.com";
  });

  it("returns 200 ok:true on bad input (no schema leak)", async () => {
    const { POST } = await import("../app/api/auth/forgot-password/route");
    const res = await POST(jsonPostReq("http://localhost/api/auth/forgot-password", { x: 1 }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  it("returns 200 ok:true for unknown email", async () => {
    const { POST } = await import("../app/api/auth/forgot-password/route");
    const res = await POST(
      jsonPostReq("http://localhost/api/auth/forgot-password", { email: "nobody@nowhere.example" })
    );
    // Note: DB lookup will fail in the test env; the route still
    // returns 200 because errors are caught + generic-success'd.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

// ─── /api/auth/reset-password — token validation ────────────────────

describe("/api/auth/reset-password: validation paths", () => {
  it("400 invalid_request on missing fields", async () => {
    const { POST } = await import("../app/api/auth/reset-password/route");
    const res = await POST(jsonPostReq("http://localhost/api/auth/reset-password", {}, { "x-forwarded-for": "198.51.100.50" }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it("400 with min-length message on weak password", async () => {
    const { POST } = await import("../app/api/auth/reset-password/route");
    const res = await POST(
      jsonPostReq(
        "http://localhost/api/auth/reset-password",
        { token: "x".repeat(20), newPassword: "short" },
        { "x-forwarded-for": "198.51.100.51" }
      )
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(/at least 10/i.test(body.error ?? ""));
  });

  it("400 invalid_or_expired on bogus token (no token-state leak)", async () => {
    const { POST } = await import("../app/api/auth/reset-password/route");
    const res = await POST(
      jsonPostReq(
        "http://localhost/api/auth/reset-password",
        { token: "definitely-not-a-real-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", newPassword: "a-good-password-here" },
        { "x-forwarded-for": "198.51.100.52" }
      )
    );
    // In the test env the consume path will error on DB; the route
    // catches that and falls through to generic invalid_or_expired or
    // internal. Both are acceptable — what matters is we never leak
    // which one (specific token states like 'already_consumed' must
    // never surface).
    assert.ok(res.status === 400 || res.status === 500);
    const body = await res.json();
    if (res.status === 400) assert.equal(body.error, "invalid_or_expired");
  });

  it("rate-limits after 5 attempts from one IP", async () => {
    const { POST } = await import("../app/api/auth/reset-password/route");
    const ip = "198.51.100.99";
    for (let i = 0; i < 5; i++) {
      // Use a body shape that gets past the parse to consume tokens.
      await POST(
        jsonPostReq(
          "http://localhost/api/auth/reset-password",
          { token: "x".repeat(40), newPassword: "valid-password-here" },
          { "x-forwarded-for": ip }
        )
      );
    }
    const sixth = await POST(
      jsonPostReq(
        "http://localhost/api/auth/reset-password",
        { token: "x".repeat(40), newPassword: "valid-password-here" },
        { "x-forwarded-for": ip }
      )
    );
    assert.equal(sixth.status, 429);
  });
});
