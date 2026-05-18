/**
 * Unit tests for lib/communications/html-lint.ts.
 *
 * Pure functions only. Verifies the lint detects every pattern we
 * commit to flagging AND that it does NOT false-positive on the
 * canonical HTML email patterns admins legitimately write.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasWarnings,
  lintHtmlTemplate,
  type LintFinding,
} from "../lib/communications/html-lint";

const findCodes = (findings: LintFinding[]): string[] =>
  findings.map((f) => f.code).sort();

describe("html-lint: detection", () => {
  it("returns empty for empty/null/undefined input", () => {
    assert.deepEqual(lintHtmlTemplate(null), []);
    assert.deepEqual(lintHtmlTemplate(undefined), []);
    assert.deepEqual(lintHtmlTemplate(""), []);
  });

  it("flags <script>", () => {
    const f = lintHtmlTemplate(`<p>Hi</p><script>alert(1)</script>`);
    assert.ok(findCodes(f).includes("script_tag"));
  });

  it("flags inline event handlers", () => {
    const f = lintHtmlTemplate(`<img src="x" onerror="alert(1)" />`);
    assert.ok(findCodes(f).includes("inline_event_handler"));
  });

  it("flags javascript: URLs", () => {
    const f = lintHtmlTemplate(`<a href="javascript:alert(1)">link</a>`);
    assert.ok(findCodes(f).includes("javascript_url"));
  });

  it("flags <iframe>", () => {
    const f = lintHtmlTemplate(`<iframe src="https://example.com" />`);
    assert.ok(findCodes(f).includes("iframe"));
  });

  it("flags <form>", () => {
    const f = lintHtmlTemplate(`<form action="/x"><input/></form>`);
    assert.ok(findCodes(f).includes("form"));
  });

  it("flags <link rel=stylesheet>", () => {
    const f = lintHtmlTemplate(`<link rel="stylesheet" href="x.css" />`);
    assert.ok(findCodes(f).includes("external_stylesheet"));
  });

  it("flags CSS position:", () => {
    const f = lintHtmlTemplate(`<div style="position: absolute; top: 0">x</div>`);
    assert.ok(findCodes(f).includes("css_position"));
  });

  it("returns warnings BEFORE info findings", () => {
    // Inputs that produce both severity tiers.
    const f = lintHtmlTemplate(
      `<script></script><link rel="stylesheet" href="x" />`
    );
    assert.equal(f.length, 2);
    assert.equal(f[0].severity, "warning");
    assert.equal(f[1].severity, "info");
  });
});

describe("html-lint: hasWarnings", () => {
  it("true when any warning present", () => {
    assert.equal(hasWarnings(lintHtmlTemplate("<script></script>")), true);
  });
  it("false when only info-severity findings", () => {
    const f = lintHtmlTemplate(`<div style="position: absolute">x</div>`);
    assert.equal(hasWarnings(f), false);
  });
  it("false when no findings", () => {
    assert.equal(hasWarnings([]), false);
  });
});

describe("html-lint: no false positives on common email patterns", () => {
  // Canonical HTML email patterns admins legitimately write. The lint
  // must NOT flag any of these.
  const SAFE_PATTERNS = [
    // Plain paragraph with variable
    `<p>Hi {{customer_name}}!</p>`,
    // Anchor with https://
    `<a href="https://example.com/cancel/{{cancel_link}}">Cancel</a>`,
    // Bold + br
    `<b>Confirmed</b><br/>{{appointment_date}}`,
    // Table layout (the gold standard for email)
    `<table cellpadding="0" cellspacing="0" width="100%"><tr><td>x</td></tr></table>`,
    // Inline styles with safe properties
    `<div style="background-color: #f5f5f5; padding: 16px; color: #333">Header</div>`,
    // Image with alt
    `<img src="https://example.com/logo.png" alt="Logo" width="120" />`,
    // Comment block
    `<!-- preheader -->`,
  ];

  for (const html of SAFE_PATTERNS) {
    it(`no warnings for: ${html.slice(0, 50)}...`, () => {
      const f = lintHtmlTemplate(html);
      assert.equal(hasWarnings(f), false, `Expected no warnings; got: ${JSON.stringify(f)}`);
    });
  }
});

describe("html-lint: case insensitivity", () => {
  it("flags <SCRIPT> uppercase", () => {
    assert.ok(findCodes(lintHtmlTemplate(`<SCRIPT></SCRIPT>`)).includes("script_tag"));
  });
  it("flags ONCLICK uppercase", () => {
    assert.ok(
      findCodes(lintHtmlTemplate(`<button ONCLICK="x()">b</button>`)).includes("inline_event_handler")
    );
  });
  it("flags JavaScript: mixed case", () => {
    assert.ok(findCodes(lintHtmlTemplate(`<a href="JavaScript:void(0)">x</a>`)).includes("javascript_url"));
  });
});
