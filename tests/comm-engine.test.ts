/**
 * Run: npm test
 *
 * Unit tests for the communication engine's pure pieces. DB-touching
 * paths (template resolver row lookup, idempotency dedup, gate I/O)
 * are covered by production smoke tests in Phase 7 — they need a live
 * Postgres which the test runner doesn't bring up.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  renderVariables,
  extractVariables,
  missingVariables,
  SUPPORTED_VARIABLES,
} from "../lib/communications/variables";
// Pure module — no DB import — so tests load without DATABASE_URL set.
// The DB-aware resolver in ./templates is verified by Phase 7 smoke
// tests against the live deployment.
import {
  TEMPLATE_TYPES,
  systemFallbackFor,
  templateStarterFor,
} from "../lib/communications/template-types";
import type { BookingForEmail } from "../lib/email";

describe("variables — renderVariables", () => {
  it("substitutes a single token", () => {
    assert.equal(
      renderVariables("Hi {{customer_name}}", { customer_name: "Alex" }),
      "Hi Alex"
    );
  });

  it("substitutes multiple tokens including repeats", () => {
    assert.equal(
      renderVariables("{{a}} and {{a}} and {{b}}", { customer_name: "x" } as Record<string, string>),
      // unknown tokens render as empty string
      " and  and "
    );
  });

  it("handles missing values as empty string (never undefined)", () => {
    assert.equal(renderVariables("X {{customer_name}} Y", {}), "X  Y");
  });

  it("treats null and undefined identically", () => {
    assert.equal(
      renderVariables("{{notes}}", { notes: null }),
      ""
    );
    assert.equal(
      renderVariables("{{notes}}", { notes: undefined }),
      ""
    );
  });

  it("tolerates whitespace inside braces", () => {
    assert.equal(
      renderVariables("Hi {{ customer_name }}!", { customer_name: "Sam" }),
      "Hi Sam!"
    );
  });

  it("is case-insensitive on the key", () => {
    assert.equal(
      renderVariables("Hi {{Customer_Name}}", { customer_name: "Lee" }),
      "Hi Lee"
    );
  });

  it("preserves non-variable braces / template content", () => {
    assert.equal(renderVariables("price: $5 — no vars", {}), "price: $5 — no vars");
    assert.equal(renderVariables("", { customer_name: "x" }), "");
  });

  it("never throws on bizarre input", () => {
    assert.doesNotThrow(() => renderVariables("{{{{notes}}}}", { notes: "x" }));
    assert.doesNotThrow(() => renderVariables("{{  }}", {}));
    assert.doesNotThrow(() => renderVariables("{{toString}}", {}));
  });
});

describe("variables — extractVariables", () => {
  it("returns only supported variable names", () => {
    const used = extractVariables("Hi {{customer_name}}, your {{nonsense_key}} appt is {{appointment_time}}.");
    assert.deepEqual(used.sort(), ["appointment_time", "customer_name"]);
  });

  it("deduplicates repeated variables", () => {
    const used = extractVariables("{{customer_name}} and {{customer_name}}");
    assert.deepEqual(used, ["customer_name"]);
  });

  it("returns empty for templates with no variables", () => {
    assert.deepEqual(extractVariables("Plain text"), []);
  });
});

describe("variables — missingVariables", () => {
  it("flags variables present in template but empty in context", () => {
    const missing = missingVariables(
      "Hi {{customer_name}}, notes: {{notes}}",
      { customer_name: "Sam", notes: "" }
    );
    assert.deepEqual(missing, ["notes"]);
  });

  it("returns empty when all template variables have values", () => {
    const missing = missingVariables(
      "Hi {{customer_name}}",
      { customer_name: "Sam" }
    );
    assert.deepEqual(missing, []);
  });
});

describe("template resolver — system fallback", () => {
  function samplePayload(): BookingForEmail {
    return {
      id: "test-id",
      serviceName: "Test Service",
      staffName: "Test Staff",
      staffEmail: "staff@example.com",
      startAt: new Date("2026-06-01T15:00:00Z"),
      endAt: new Date("2026-06-01T16:00:00Z"),
      clientName: "Test Client",
      clientEmail: "client@example.com",
      clientTimezone: "UTC",
      meetLink: null,
      tenantName: "Test Workspace",
    };
  }

  it("renders a non-empty subject + html + text for every template type", () => {
    for (const type of TEMPLATE_TYPES) {
      const out = systemFallbackFor(type, samplePayload());
      assert.equal(out.source, "system", `${type} source`);
      assert.ok(out.subject.length > 0, `${type} subject`);
      assert.ok(out.html.length > 0, `${type} html`);
      assert.ok(out.text.length > 0, `${type} text`);
    }
  });

  it("reminder_2h renders a distinct 2-hour label (not the 24h/1h copy)", () => {
    const two = systemFallbackFor("reminder_2h", samplePayload());
    const blob = `${two.subject} ${two.text} ${two.html}`;
    assert.ok(/2 hours away/.test(blob), "2h reminder should carry the '2 hours away' label");
    // Guard against a copy-paste of the adjacent windows' wording.
    assert.ok(!/24 hours away/.test(blob), "2h reminder must not say '24 hours away'");
    assert.ok(!/1 hour away/.test(blob), "2h reminder must not say '1 hour away'");
  });

  it("each system default subject mentions either the service or the business name", () => {
    // The post-completion templates (review_request, followup,
    // appointment_completed, appointment_no_show) deliberately lead
    // with the BUSINESS name — customers recognize the business by
    // name at review/followup time, not by the service. The original
    // five templates lead with the service name for "what just happened"
    // clarity. Either is acceptable.
    for (const type of TEMPLATE_TYPES) {
      const out = systemFallbackFor(type, samplePayload());
      const hasServiceName = out.subject.includes("Test Service");
      const hasBusinessName = out.subject.includes("Test Workspace");
      assert.ok(
        hasServiceName || hasBusinessName,
        `${type} subject lacks both service and business name: ${out.subject}`
      );
    }
  });
});

describe("template resolver — starter for editor", () => {
  it("returns a starter for each template type", () => {
    for (const type of TEMPLATE_TYPES) {
      const starter = templateStarterFor(type);
      assert.ok(starter.subject);
      assert.ok(starter.html);
      assert.ok(starter.text);
    }
  });

  it("starter HTML carries variable placeholders the editor can show", () => {
    const starter = templateStarterFor("booking_confirmation");
    // The starter is built from a sample payload whose fields are
    // {{var}}-shaped strings; the html should contain at least one of
    // those tokens so the admin sees the variable convention.
    const hasAnyVar = SUPPORTED_VARIABLES.some((v) =>
      starter.html.includes(`{{${v}}}`)
    );
    assert.ok(hasAnyVar, `starter html should contain at least one {{var}} placeholder`);
  });
});
