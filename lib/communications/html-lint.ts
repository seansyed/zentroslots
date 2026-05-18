/**
 * Lightweight HTML safety lint for the template editor.
 *
 * NOT a sanitizer — we deliberately don't strip anything. Admins are
 * trusted with their own content (templates render in their customers'
 * inboxes, not in our pages), and the email itself never executes JS in
 * a way that matters server-side. But "you've put <script> in an email"
 * is something we should TELL them about — most clients silently drop
 * <script> tags, so seeing a script tag in a template usually means a
 * copy-paste mistake from a web page.
 *
 * Output is a structured list of findings with severities. The editor
 * surfaces them as a non-blocking warning panel; save still proceeds.
 *
 * Pure (no DOM, no DB) — testable with node:test.
 */

export type LintSeverity = "warning" | "info";

export type LintFinding = {
  severity: LintSeverity;
  code: string;
  message: string;
};

// Patterns we look for. Each entry: regex + finding to emit if matched.
// Kept conservative — false positives are annoying for an admin who
// pastes legitimate HTML.
const PATTERNS: { re: RegExp; finding: Omit<LintFinding, "severity"> & { severity?: LintSeverity } }[] = [
  {
    re: /<script\b/i,
    finding: {
      severity: "warning",
      code: "script_tag",
      message: "<script> tags are stripped by most email clients (Gmail, Outlook). Remove unless you know your audience renders them.",
    },
  },
  {
    re: /\bon\w+\s*=\s*["'][^"']*["']/i, // onclick= onerror= onload= …
    finding: {
      severity: "warning",
      code: "inline_event_handler",
      message: "Inline event handlers (onclick, onerror, etc.) are stripped by email clients and never run.",
    },
  },
  {
    re: /\bjavascript:\s*/i,
    finding: {
      severity: "warning",
      code: "javascript_url",
      message: "javascript: URLs are stripped by email clients. Use a regular https:// link or {{cancel_link}}/{{reschedule_link}} variables.",
    },
  },
  {
    re: /<iframe\b/i,
    finding: {
      severity: "warning",
      code: "iframe",
      message: "<iframe> is blocked in almost all email clients.",
    },
  },
  {
    re: /<form\b/i,
    finding: {
      severity: "warning",
      code: "form",
      message: "<form> elements don't work reliably in email — most clients render them as plain content.",
    },
  },
  {
    re: /<link\b[^>]*rel\s*=\s*["']?stylesheet/i,
    finding: {
      severity: "info",
      code: "external_stylesheet",
      message: "External stylesheets (<link rel=\"stylesheet\">) are blocked in most clients. Inline your styles.",
    },
  },
  {
    re: /style\s*=\s*["'][^"']*position\s*:/i,
    finding: {
      severity: "info",
      code: "css_position",
      message: "CSS position: is unsupported in many email clients. Stick to table-based layouts.",
    },
  },
];

/**
 * Returns 0..N findings. Empty array = looks clean. Order: warnings
 * first, then info, in the order they appear in PATTERNS.
 */
export function lintHtmlTemplate(html: string | null | undefined): LintFinding[] {
  if (!html) return [];
  const findings: LintFinding[] = [];
  for (const { re, finding } of PATTERNS) {
    if (re.test(html)) {
      findings.push({
        severity: (finding.severity as LintSeverity) ?? "warning",
        code: finding.code,
        message: finding.message,
      });
    }
  }
  // Stable: warnings first, then info.
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warning" ? -1 : 1));
  return findings;
}

/**
 * Convenience: any warning-severity finding present? Used by the editor
 * to decide whether to render the warning panel at all.
 */
export function hasWarnings(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === "warning");
}
