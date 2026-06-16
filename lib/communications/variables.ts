/**
 * Template variable rendering.
 *
 * Substitution is `{{snake_case_key}}`. Missing keys render as empty
 * string so a malformed template can never throw or leak `undefined`.
 * HTML/text rendering is identical — escaping is the template author's
 * job (the system defaults handle that; custom templates are pre-
 * inspected at save time to flag risky content).
 *
 * Supported variable names are a hard whitelist (`SUPPORTED_VARIABLES`)
 * so the UI's variable picker stays in lock-step with the engine.
 */

export const SUPPORTED_VARIABLES = [
  "customer_name",
  "customer_first_name",
  "business_name",
  "service_name",
  "staff_name",
  "appointment_date",
  "appointment_time",
  "appointment_end_time",
  // Timezone abbreviation (PDT/EST/UTC) so authors can show an unambiguous
  // time: "{{appointment_time}} {{appointment_timezone}}".
  "appointment_timezone",
  "location_name",
  "meeting_link",
  "booking_link",
  "cancel_link",
  "reschedule_link",
  "business_phone",
  "business_email",
  "notes",
  // Added with the review-request + follow-up automations:
  "review_url",
  "review_platform",
  // Added with the waitlist + slot-release automations:
  "claim_url",
  "claim_expires_at",
] as const;

export type TemplateVariable = (typeof SUPPORTED_VARIABLES)[number];

export type TemplateContext = Partial<Record<TemplateVariable, string | null | undefined>>;

const VARIABLE_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** HTML-escape a single substituted value when rendering INTO HTML.
 *  Keeps the template author's literal HTML markup intact (the
 *  template's static surrounding text), only escaping the substituted
 *  customer/tenant fields. Used when `renderVariables` is called with
 *  `{ escapeHtml: true }` — the engine sets this for HTML output. */
function escapeHtmlValue(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render `{{var}}` placeholders. Unknown / missing keys → empty string.
 * Preserves the original template format (line breaks, casing). Pure
 * function — no I/O. Safe to call from anywhere.
 *
 * When `options.escapeHtml` is true, substituted VALUES are HTML-escaped
 * before insertion so a customer name like `<script>` cannot break the
 * surrounding HTML markup or inject content into the email. The
 * template author's literal HTML is unaffected — only the substituted
 * field values are escaped. Default false preserves existing behavior
 * for all current callers (text rendering, admin editor preview, etc).
 */
export function renderVariables(
  template: string,
  context: TemplateContext,
  options?: { escapeHtml?: boolean }
): string {
  if (!template) return "";
  const escape = options?.escapeHtml === true;
  return template.replace(VARIABLE_PATTERN, (_match, rawKey: string) => {
    const key = rawKey.toLowerCase() as TemplateVariable;
    const value = context[key];
    if (value == null) return "";
    const str = String(value);
    return escape ? escapeHtmlValue(str) : str;
  });
}

/**
 * Returns the list of variable names that appear in the template. Used
 * by the admin editor for "variables used in this template" hints and
 * by tests to assert seam coverage.
 */
export function extractVariables(template: string): TemplateVariable[] {
  if (!template) return [];
  const seen = new Set<TemplateVariable>();
  let m: RegExpExecArray | null;
  // Local regex (don't share the module-level one — it carries lastIndex).
  const re = new RegExp(VARIABLE_PATTERN.source, "gi");
  while ((m = re.exec(template)) !== null) {
    const key = m[1].toLowerCase() as TemplateVariable;
    if ((SUPPORTED_VARIABLES as readonly string[]).includes(key)) {
      seen.add(key);
    }
  }
  return Array.from(seen);
}

/**
 * Returns the variable names referenced by the template that aren't in
 * the supplied context (or are present but empty). Useful for preview
 * warnings — "this template uses {{notes}} but the booking has no notes."
 */
export function missingVariables(
  template: string,
  context: TemplateContext
): TemplateVariable[] {
  const used = extractVariables(template);
  return used.filter((k) => {
    const v = context[k];
    return v == null || String(v).length === 0;
  });
}
