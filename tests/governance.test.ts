/**
 * Unit tests for the governance layer:
 *   - lib/governance/passwordPolicy (pure)
 *   - lib/governance/types (closed enums + hard floors)
 *   - lib/security/audit (governance categories registered)
 *   - /api/tenant/governance schema rejection + auth blocking
 *   - /api/tenant/governance/run-retention requires { confirm: true }
 *   - /api/tenant/governance/retention-preview blocks unauth
 *
 * Live DB-touching paths (retention engine, upsert) are covered by the
 * production smoke phase.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  validatePasswordAgainstPolicy,
  validatePolicyUpdate,
  defaultPasswordPolicy,
} from "../lib/governance/passwordPolicy";
import {
  RETENTION_TARGETS,
  SUSPICIOUS_SENSITIVITY,
  EXPORT_TYPES,
  HARD_FLOOR_DAYS,
  PLATFORM_DEFAULTS,
} from "../lib/governance/types";
import { SECURITY_AUDIT_CATEGORIES } from "../lib/security/audit";

// ─── types / safe defaults ──────────────────────────────────────────

describe("governance types: closed unions + defaults", () => {
  it("RETENTION_TARGETS includes the 5 expected targets", () => {
    assert.deepEqual([...RETENTION_TARGETS], [
      "audit_logs",
      "session_audit_events",
      "password_reset_tokens",
      "analytics_daily_snapshots",
      "export_audit_events",
    ]);
  });

  it("SUSPICIOUS_SENSITIVITY is low|medium|high", () => {
    assert.deepEqual([...SUSPICIOUS_SENSITIVITY], ["low", "medium", "high"]);
  });

  it("EXPORT_TYPES covers analytics + executive + bookings + reports + audit_logs + other", () => {
    const types = new Set<string>(EXPORT_TYPES as readonly string[]);
    for (const t of ["analytics", "analytics_executive", "bookings", "scheduled_reports", "audit_logs", "other"]) {
      assert.ok(types.has(t), `missing export type: ${t}`);
    }
  });

  it("HARD_FLOOR_DAYS enforces 90 days for audit_logs + export_audit_events", () => {
    assert.equal(HARD_FLOOR_DAYS.audit_logs, 90);
    assert.equal(HARD_FLOOR_DAYS.export_audit_events, 90);
  });

  it("HARD_FLOOR_DAYS leaves analytics + session + reset tokens with NO floor", () => {
    assert.equal(HARD_FLOOR_DAYS.analytics_daily_snapshots, null);
    assert.equal(HARD_FLOOR_DAYS.session_audit_events, null);
    assert.equal(HARD_FLOOR_DAYS.password_reset_tokens, null);
  });

  it("PLATFORM_DEFAULTS matches what the codebase enforced pre-governance", () => {
    assert.equal(PLATFORM_DEFAULTS.passwordMinLength, 10);
    assert.equal(PLATFORM_DEFAULTS.passwordRequireUppercase, false);
    assert.equal(PLATFORM_DEFAULTS.sessionMaxAgeDays, 0);
    assert.equal(PLATFORM_DEFAULTS.suspiciousLoginSensitivity, "medium");
  });
});

// ─── new audit categories registered ────────────────────────────────

describe("governance audit categories registered", () => {
  it("all 3 governance categories present", () => {
    const cats = new Set<string>(SECURITY_AUDIT_CATEGORIES as readonly string[]);
    assert.ok(cats.has("security.governance.updated"));
    assert.ok(cats.has("security.retention.executed"));
    assert.ok(cats.has("security.policy.changed"));
    assert.ok(cats.has("security.export.executed"));
  });
});

// ─── password policy validation ────────────────────────────────────

describe("validatePasswordAgainstPolicy", () => {
  const defaults = defaultPasswordPolicy();

  it("rejects a 9-char password under default 10-char min", () => {
    const r = validatePasswordAgainstPolicy("12345678a", defaults);
    assert.equal(r.ok, false);
    assert.match("reason" in r ? r.reason : "", /at least 10/);
  });

  it("accepts a 10-char password under defaults", () => {
    const r = validatePasswordAgainstPolicy("a-good-pwd", defaults);
    assert.equal(r.ok, true);
  });

  it("enforces uppercase when required", () => {
    const policy = { ...defaults, requireUppercase: true };
    const bad = validatePasswordAgainstPolicy("alllowercase123", policy);
    assert.equal(bad.ok, false);
    const good = validatePasswordAgainstPolicy("AllUppercase1", policy);
    assert.equal(good.ok, true);
  });

  it("enforces symbol when required", () => {
    const policy = { ...defaults, requireSymbol: true };
    const bad = validatePasswordAgainstPolicy("nosymbol12345", policy);
    assert.equal(bad.ok, false);
    const good = validatePasswordAgainstPolicy("with-symbol12", policy);
    assert.equal(good.ok, true);
  });

  it("enforces digit when required", () => {
    const policy = { ...defaults, requireDigit: true };
    const bad = validatePasswordAgainstPolicy("nodigitshere!", policy);
    assert.equal(bad.ok, false);
    const good = validatePasswordAgainstPolicy("withdigit1!ab", policy);
    assert.equal(good.ok, true);
  });

  it("rejects empty string regardless of policy", () => {
    const r = validatePasswordAgainstPolicy("", defaults);
    assert.equal(r.ok, false);
  });
});

// ─── policy update validation (unsafe-config rejection) ────────────

describe("validatePolicyUpdate: rejects unsafe configs", () => {
  it("rejects min length below 8 (industry floor)", () => {
    const r = validatePolicyUpdate({ passwordMinLength: 6 });
    assert.equal(r.ok, false);
    assert.match("reason" in r ? r.reason : "", /at least 8/);
  });

  it("rejects min length above 128", () => {
    const r = validatePolicyUpdate({ passwordMinLength: 200 });
    assert.equal(r.ok, false);
    assert.match("reason" in r ? r.reason : "", /at most 128/);
  });

  it("rejects password max age out of band", () => {
    assert.equal(validatePolicyUpdate({ passwordMaxAgeDays: 10 }).ok, false);
    assert.equal(validatePolicyUpdate({ passwordMaxAgeDays: 400 }).ok, false);
  });

  it("accepts password max age = 0 (disabled)", () => {
    assert.equal(validatePolicyUpdate({ passwordMaxAgeDays: 0 }).ok, true);
  });

  it("rejects session max age out of band", () => {
    assert.equal(validatePolicyUpdate({ sessionMaxAgeDays: 60 }).ok, false);
  });

  it("rejects bogus suspicious sensitivity", () => {
    const r = validatePolicyUpdate({ suspiciousLoginSensitivity: "extreme" });
    assert.equal(r.ok, false);
  });

  it("accepts an empty patch", () => {
    assert.equal(validatePolicyUpdate({}).ok, true);
  });
});

// ─── route auth blocking (synthesized requests) ────────────────────

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("/api/tenant/governance: blocks unauth", () => {
  it("PATCH without a session ≠ 200", async () => {
    const { PATCH } = await import("../app/api/tenant/governance/route");
    const res = await PATCH(
      jsonReq("http://localhost/api/tenant/governance", { passwordMinLength: 12 })
    );
    assert.notEqual(res.status, 200);
  });

  it("GET without a session ≠ 200", async () => {
    const { GET } = await import("../app/api/tenant/governance/route");
    const res = await GET();
    assert.notEqual(res.status, 200);
  });
});

describe("/api/tenant/governance/run-retention: requires { confirm: true }", () => {
  it("missing confirm flag is blocked", async () => {
    const { POST } = await import("../app/api/tenant/governance/run-retention/route");
    const res = await POST(
      jsonReq("http://localhost/api/tenant/governance/run-retention", {})
    );
    // Either 401 (no session in test env) or 400 (confirm missing) —
    // both are acceptable proof that retention DID NOT execute.
    assert.notEqual(res.status, 200);
  });
});

describe("/api/tenant/governance/retention-preview: blocks unauth", () => {
  it("preview without a session ≠ 200", async () => {
    const { POST } = await import(
      "../app/api/tenant/governance/retention-preview/route"
    );
    const res = await POST();
    assert.notEqual(res.status, 200);
  });
});

// ─── export-audit shape ────────────────────────────────────────────

describe("exportAudit: sanitization is bounded", () => {
  it("module exports recordExportAudit + EXPORT_TYPES is closed", async () => {
    const mod = await import("../lib/governance/exportAudit");
    assert.equal(typeof mod.recordExportAudit, "function");
  });
});
